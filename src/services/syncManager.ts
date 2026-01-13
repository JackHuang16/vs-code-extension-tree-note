import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";
import { Manifest, ManifestItem } from "../types";
import {
  MANIFEST_FILENAME,
  MAX_TOTAL_SIZE_MB,
  MAX_FILE_SIZE_MB,
  BATCH_SIZE,
} from "../constants";
import { calculateSha1 } from "../utils/cryptoUtils";

interface SyncAction {
  type: "upload" | "download" | "conflict_gist" | "delete";
  localPath: string; // Absolute path
  remoteItem?: ManifestItem;
  content?: string;
  localContent?: string; // Content of local file before conflict rename
  reason?: string;
}

export class SyncManager {
  private isSyncing = false;

  constructor(
    private gistService: GistService,
    private localState: LocalStateManager
  ) {}

  public async sync(rootPath: string): Promise<void> {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;

    try {
      // 1. Check/Get Gist ID
      let gistId = this.localState.getGistId();
      if (!gistId) {
        const resultId = await this.promptForGist();
        if (!resultId) {
          return;
        } // User cancelled
        gistId = resultId;
        this.localState.setGistId(gistId);
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tree Note Sync",
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: "Connecting to Gist..." });

          // 2. Fetch Remote Manifest
          let remoteManifest: Manifest | null = null;
          let gistFiles: any = {};
          let gistUpdatedAt = 0;

          try {
            const gist = await this.gistService.getGist(gistId);
            gistUpdatedAt = new Date(gist.updated_at).getTime();
            gistFiles = gist.files;
            if (gistFiles[MANIFEST_FILENAME]) {
              try {
                remoteManifest = JSON.parse(
                  gistFiles[MANIFEST_FILENAME].content
                );
              } catch (e) {
                // Manifest corrupted
                const choice = await vscode.window.showErrorMessage(
                  "Cloud synchronization settings are corrupted. How would you like to proceed?",
                  "Force Push (Overwrite Cloud)",
                  "Cancel"
                );
                if (choice !== "Force Push (Overwrite Cloud)") {
                  return;
                }
                remoteManifest = {
                  version: "1.0",
                  lastSync: new Date().toISOString(),
                  items: [],
                };
              }
            } else {
              // New Gist or no manifest
              remoteManifest = {
                version: "1.0",
                lastSync: new Date().toISOString(),
                items: [],
              };
            }
          } catch (error: any) {
            const errorMsg = String(error);
            let selection: string | undefined;

            if (errorMsg.includes("404")) {
              selection = await vscode.window.showErrorMessage(
                "無法讀取遠端 Gist (404 Not Found)。該 Gist 可能已被刪除。是否要重置連結設定以重新建立？",
                "重置設定",
                "取消"
              );
            } else {
              // For other errors, providing an option to reset is also helpful (e.g. 401/403 or corrupted ID)
              selection = await vscode.window.showErrorMessage(
                `同步發生錯誤: ${errorMsg}`,
                "重置連結設定",
                "取消"
              );
            }

            if (selection === "重置設定" || selection === "重置連結設定") {
              this.localState.setGistId("");
              vscode.window.showInformationMessage(
                "已重置連結設定，正在重新啟動同步流程..."
              );
              // Important: Reset flag so the next command is not blocked
              this.isSyncing = false;
              // Trigger new sync after a small delay to allow current one to finish
              setTimeout(() => {
                vscode.commands.executeCommand("treeNote.syncToGist");
              }, 500);
            }
            return;
          }

          // 3. Scan Local Files
          progress.report({ message: "Scanning local files..." });
          const localFiles = this.scanLocalFiles(rootPath);

          // 4. Pre-check Sizes
          try {
            this.performSizeCheck(localFiles);
          } catch (e: any) {
            const choice = await vscode.window.showWarningMessage(
              e.message,
              "Continue",
              "Cancel"
            );
            if (choice !== "Continue") {
              return;
            }
          }

          // 5. Compute Diff
          progress.report({ message: "Calculating differences..." });

          const actions = await this.computeDiff(
            rootPath,
            localFiles,
            remoteManifest!,
            gistFiles
          );

          // 6. Execute Actions (Batching)
          // 6. Execute Actions (Batching)
          const uploadActions = actions.filter(
            (a) => a.type === "upload" || a.type === "delete"
          );
          const downloadActions = actions.filter(
            (a) => a.type === "download" || a.type === "conflict_gist"
          );

          // Handle Conflict Renames & Downloads first (Local operations)
          for (const action of downloadActions) {
            if (action.type === "conflict_gist") {
              // Strategy: Local Wins.
              // 1. Keep local file AS IS (Local content).
              // 2. Create a NEW local file for the Remote content: "filename (Gist Conflict).md"
              // 3. Upload BOTH files to Gist.

              // Generate Timestamp: YYYY-MM-DD HH-mm-ss
              // Note: We use '-' instead of '/' and ':' because they are invalid in filenames on most OS.
              const now = new Date();
              const YYYY = now.getFullYear();
              const MM = String(now.getMonth() + 1).padStart(2, "0");
              const DD = String(now.getDate()).padStart(2, "0");
              const hh = String(now.getHours()).padStart(2, "0");
              const mm = String(now.getMinutes()).padStart(2, "0");
              const ss = String(now.getSeconds()).padStart(2, "0");

              const timestamp = `${YYYY}-${MM}-${DD} ${hh}h-${mm}m-${ss}s`;

              const ext = path.extname(action.localPath);
              const conflictPath = path.join(
                path.dirname(action.localPath),
                `${path.basename(
                  action.localPath,
                  ext
                )} (Gist Conflict ${timestamp})${ext}`
              );

              // Write Remote Content to the new Conflict File
              if (action.content) {
                fs.writeFileSync(conflictPath, action.content, "utf8");
                const hash = calculateSha1(action.content);
                this.localState.updateFileBaseHash(conflictPath, hash);

                // 2. Queue Upload for this new Gist Conflict file
                uploadActions.push({
                  type: "upload",
                  localPath: conflictPath,
                  content: action.content,
                });
              }

              // 3. Queue Upload for the Original File (Local Content wins -> Overwrite Remote)
              if (action.localContent !== undefined) {
                uploadActions.push({
                  type: "upload",
                  localPath: action.localPath,
                  content: action.localContent,
                });
                // We also need to update the base hash for the original file to match the local content
                // so the next sync sees it as clean.
                const localHash = calculateSha1(action.localContent);
                this.localState.updateFileBaseHash(action.localPath, localHash);
              }
            } else if (action.type === "download") {
              // New remote file or remote update
              if (action.content) {
                const targetDir = path.dirname(action.localPath);
                if (!fs.existsSync(targetDir)) {
                  fs.mkdirSync(targetDir, { recursive: true });
                }
                fs.writeFileSync(action.localPath, action.content, "utf8");

                const hash = calculateSha1(action.content);
                this.localState.updateFileBaseHash(action.localPath, hash);

                if (action.remoteItem) {
                  this.localState.updateFileRecord(
                    action.localPath,
                    action.remoteItem.lastModified
                  );
                }
              }
            }
          }

          // Handle Uploads & Deletes (Remote operations) -> Batching
          if (uploadActions.length > 0) {
            let totalBatches = Math.ceil(uploadActions.length / BATCH_SIZE);

            for (let i = 0; i < uploadActions.length; i += BATCH_SIZE) {
              const batch = uploadActions.slice(i, i + BATCH_SIZE);
              const patchFiles: Record<string, { content: string } | null> = {};

              progress.report({
                message: `Syncing batch ${Math.ceil(
                  (i + 1) / BATCH_SIZE
                )}/${totalBatches}...`,
                increment: (1 / totalBatches) * 50,
              });

              for (const action of batch) {
                if (action.type === "delete" && action.remoteItem) {
                  // DELETE
                  patchFiles[action.remoteItem.gistFilename] = null;

                  // Remove from Manifest Memory
                  remoteManifest!.items = remoteManifest!.items.filter(
                    (item) => item.id !== action.remoteItem!.id
                  );

                  // Clean up Local State Tombstone
                  this.localState.removeRecordById(action.remoteItem.id);
                } else if (
                  action.type === "upload" &&
                  action.content !== undefined
                ) {
                  // Check for Empty Content (Gist API Limitation)
                  if (action.content === "") {
                    vscode.window.showWarningMessage(
                      `Skipped empty file: ${path.basename(
                        action.localPath
                      )} (GitHub Gist does not support empty files)`
                    );
                    continue;
                  }

                  // UPLOAD
                  let gistFilename = path.basename(action.localPath);
                  const id = this.localState.getFileId(action.localPath);

                  // Check existing mapping
                  const existingItem = remoteManifest?.items.find(
                    (item) => item.id === id
                  );

                  if (existingItem) {
                    gistFilename = existingItem.gistFilename;
                  } else {
                    // New file collision check
                    if (gistFiles[gistFilename]) {
                      gistFilename = gistFilename.replace(
                        ".md",
                        `-${id.substring(0, 8)}.md`
                      );
                    }
                  }

                  patchFiles[gistFilename] = { content: action.content };

                  // Update Manifest object in memory
                  const now = Date.now();
                  const relativePath = path.relative(
                    rootPath,
                    action.localPath
                  );
                  const itemIdx = remoteManifest!.items.findIndex(
                    (item) => item.id === id
                  );
                  const newItem: ManifestItem = {
                    id: id,
                    path: relativePath,
                    gistFilename: gistFilename,
                    lastModified: now,
                  };

                  if (itemIdx >= 0) {
                    remoteManifest!.items[itemIdx] = newItem;
                  } else {
                    remoteManifest!.items.push(newItem);
                  }

                  // Update local state lastModified
                  this.localState.updateFileRecord(action.localPath, now);
                }
              }

              // Execute Patch for this batch
              if (Object.keys(patchFiles).length > 0) {
                await this.gistService.updateGist(gistId, patchFiles);
              }
            }
          }

          // Update Base Hashes for successful Uploads
          for (const action of uploadActions) {
            if (action.type === "upload" && action.content !== undefined) {
              const hash = calculateSha1(action.content);
              this.localState.updateFileBaseHash(action.localPath, hash);
            }
          }

          // 7. Final Step: Update Manifest
          progress.report({ message: "Updating manifest..." });
          remoteManifest!.lastSync = new Date().toISOString();
          await this.gistService.updateGist(gistId, {
            [MANIFEST_FILENAME]: {
              content: JSON.stringify(remoteManifest, null, 2),
            },
          });

          this.localState.setLastSyncTime(Date.now());
          vscode.window.showInformationMessage(
            "Tree Note synchronization complete!"
          );
        }
      );
    } finally {
      this.isSyncing = false;
    }
  }

  private scanLocalFiles(rootPath: string): string[] {
    const results: string[] = [];
    const stack = [rootPath];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!fs.existsSync(current)) continue;

      const stats = fs.statSync(current);
      if (stats.isDirectory()) {
        const children = fs.readdirSync(current);
        for (const child of children) {
          if (child.startsWith(".")) continue; // skip hidden
          stack.push(path.join(current, child));
        }
      } else if (stats.isFile() && current.endsWith(".md")) {
        results.push(current);
      }
    }
    return results;
  }

  private performSizeCheck(files: string[]) {
    let totalSize = 0;
    const largeFiles: string[] = [];

    for (const file of files) {
      const stats = fs.statSync(file);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > MAX_FILE_SIZE_MB) {
        largeFiles.push(path.basename(file));
      } else {
        totalSize += sizeMB;
      }
    }

    if (largeFiles.length > 0) {
      vscode.window.showWarningMessage(
        `Skipped files larger than ${MAX_FILE_SIZE_MB}MB: ${largeFiles.join(
          ", "
        )}. Consider using image links.`
      );
    }

    if (totalSize > MAX_TOTAL_SIZE_MB) {
      throw new Error(
        `Total sync size (${totalSize.toFixed(
          1
        )}MB) exceeds the recommended limit of ${MAX_TOTAL_SIZE_MB}MB. Sync may be unstable.`
      );
    }
  }

  private async computeDiff(
    rootPath: string,
    localFiles: string[],
    remoteManifest: Manifest,
    gistFiles: any
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    const localProcessedIds = new Set<string>();

    // 1. Check Local Files (Uploads / Updates / Conflicts)
    for (const file of localFiles) {
      const stats = fs.statSync(file);
      if (stats.size / (1024 * 1024) > MAX_FILE_SIZE_MB) continue;

      const id = this.localState.getFileId(file);
      localProcessedIds.add(id);

      const localContent = fs.readFileSync(file, "utf8");
      const localHash = calculateSha1(localContent);

      const localSyncItem = this.localState.getSyncItem(file);
      const baseHash = localSyncItem?.baseHash;

      const remoteItem = remoteManifest.items.find((i) => i.id === id);

      let remoteHash: string | undefined;
      let remoteContent: string | undefined;

      if (remoteItem && gistFiles[remoteItem.gistFilename]) {
        remoteContent = gistFiles[remoteItem.gistFilename].content;
        if (remoteContent !== undefined) {
          remoteHash = calculateSha1(remoteContent);
        }
      }

      if (!remoteItem || remoteHash === undefined) {
        // Case: New Local File (or Remote Missing) -> Upload
        actions.push({
          type: "upload",
          localPath: file,
          content: localContent,
        });
      } else {
        // Both exist. 3-Way Merge Strategy.
        // 1. In Sync
        if (localHash === remoteHash) {
          continue;
        }
        // 2. Remote Changed, Local Clean (Download)
        // Condition: Local == Base && Remote != Base
        else if (localHash === baseHash && remoteHash !== baseHash) {
          actions.push({
            type: "download",
            localPath: file,
            content: remoteContent!,
            remoteItem: remoteItem,
          });
        }
        // 3. Local Changed, Remote Clean (Upload)
        // Condition: Local != Base && Remote == Base
        else if (localHash !== baseHash && remoteHash === baseHash) {
          actions.push({
            type: "upload",
            localPath: file,
            content: localContent,
          });
        }
        // 4. Both Changed (Conflict)
        else {
          // Conflict!
          actions.push({
            type: "conflict_gist",
            localPath: file,
            remoteItem: remoteItem,
            content: remoteContent!, // This will go into (Gist Conflict) file
            localContent: localContent, // This will stay in original file and overwrite Remote
          });
        }
      }
    }

    // 2. Check Remote Items (Missing Locally -> Download/Restore or Delete)
    const localMapValues = Object.values(this.localState.getFullMap().files);

    for (const item of remoteManifest.items) {
      if (localProcessedIds.has(item.id)) continue;

      // 1. Check Explicit Tombstone
      const localRecord = localMapValues.find((f) => f.id === item.id);
      if (localRecord && localRecord.deleted) {
        actions.push({
          type: "delete",
          localPath: "",
          remoteItem: item,
        });
        continue;
      }

      // 2. Implicit Delete Check (Git-style)
      // If no local file, and Remote Content is SAME as what we last synced (Base),
      // it means the user deleted it locally (even without Tombstone).
      // If Remote Content CHANGED, we restore it (Download) to protect data.

      let shouldDelete = false;

      if (gistFiles[item.gistFilename]) {
        const remoteContent = gistFiles[item.gistFilename].content || "";

        // If we have a local record with baseHash, compare it.
        if (localRecord?.baseHash) {
          const remoteHash = calculateSha1(remoteContent);
          if (remoteHash === localRecord.baseHash) {
            shouldDelete = true;
          }
        }
      }

      if (shouldDelete) {
        actions.push({
          type: "delete",
          localPath: "",
          remoteItem: item,
        });
      } else if (gistFiles[item.gistFilename]) {
        // Restore / Download
        const targetPath = path.join(rootPath, item.path);
        actions.push({
          type: "download",
          localPath: targetPath,
          content: gistFiles[item.gistFilename].content,
          remoteItem: item,
        });
      }
    }

    return actions;
  }

  private async promptForGist(): Promise<string | undefined> {
    const createOption = "Create New GitHub Secret Gist";
    const existingOption = "Connect to Existing GitHub Gist ID";

    // Explicitly inform the user about GitHub Gist usage
    const selection = await vscode.window.showQuickPick(
      [createOption, existingOption],
      {
        placeHolder:
          "Tree Note Cloud Sync: Choose how to sync with GitHub Gist",
        ignoreFocusOut: true,
      }
    );

    if (selection === createOption) {
      const description = await vscode.window.showInputBox({
        prompt: "Enter Gist Description",
        value: "Tree Note Sync Data",
      });
      if (!description) return undefined;

      const gist = await this.gistService.createGist(description, {
        [MANIFEST_FILENAME]: {
          content: JSON.stringify({
            version: "1.0",
            lastSync: new Date().toISOString(),
            items: [],
          }),
        },
      });
      return gist.id;
    } else if (selection === existingOption) {
      return await vscode.window.showInputBox({
        prompt: "Enter Gist ID",
        placeHolder: "e.g. 78a...",
      });
    }

    return undefined;
  }
}
