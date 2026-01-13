import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";
import { Manifest, ManifestItem, LocalSyncItem, LocalSyncMap } from "../types";
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
      // 1. Local Pre-check (File Size Check First)
      const localFiles = this.scanLocalFiles(rootPath);
      try {
        await this.performSizeCheck(localFiles);
      } catch (e: any) {
        // Sync cancelled or error occurred in size check
        return;
      }

      // 2. Identify Target (Cloud Check)
      let gistId = this.localState.getGistId();

      if (gistId) {
        // Quick connection test since ID exists
        try {
          await this.gistService.getGist(gistId);
        } catch (error: any) {
          if (String(error).includes("404")) {
            this.localState.setGistId("");
            gistId = ""; // Force re-identification
            vscode.window.showWarningMessage(
              "The linked Gist no longer exists. Please reconnect."
            );
          } else {
            throw error; // Other network errors
          }
        }
      }

      // 3. Identification / Creation (If no valid ID)
      if (!gistId) {
        const resultId = await this.promptForGist();
        if (!resultId) {
          return;
        }
        gistId = resultId;
        this.localState.setGistId(gistId);
      }

      // 4. Official Sync with Progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tree Note Sync",
          cancellable: true,
        },
        async (progress, token) => {
          if (token.isCancellationRequested) {
            return;
          }

          progress.report({ message: "Connecting to Gist..." });

          // 5. Fetch Remote Manifest
          let remoteManifest: Manifest | null = null;
          let gistFiles: any = {};

          try {
            const gist = await this.gistService.getGist(gistId!);
            if (token.isCancellationRequested) {
              return;
            }

            // Security Check: Only Secret Gists are allowed
            if (gist.public) {
              this.localState.setGistId("");
              await vscode.window.showErrorMessage(
                "For privacy reasons, Tree Note only supports using Secret Gists. The linked Gist is currently Public, so the connection has been terminated. Please re-sync and create or select a Secret Gist.",
                { modal: true }
              );
              return;
            }

            gistFiles = gist.files;
            const hasExistingFiles = Object.keys(gistFiles).some(
              (name) => name !== MANIFEST_FILENAME
            );

            if (gistFiles[MANIFEST_FILENAME]) {
              try {
                remoteManifest = JSON.parse(
                  gistFiles[MANIFEST_FILENAME].content
                );
              } catch (e) {
                const choice = await vscode.window.showErrorMessage(
                  "Cloud settings (manifest.json) corrupted. How would you like to proceed?",
                  { modal: true },
                  { title: "Overwrite Cloud", isCloseAffordance: false },
                  { title: "Cancel", isCloseAffordance: true }
                );
                if (choice?.title !== "Overwrite Cloud") {
                  return;
                }
                remoteManifest = {
                  version: "1.0",
                  lastSync: new Date(0).toISOString(),
                  items: [],
                };
              }
            } else if (hasExistingFiles) {
              const mergeItem: vscode.MessageItem = {
                title: "Merge (Download Cloud Data)",
              };
              const overwriteItem: vscode.MessageItem = {
                title: "Overwrite (Keep Local Only)",
              };

              const choice = await vscode.window.showWarningMessage(
                "This Gist contains existing data but no sync record. Would you like to download existing files?",
                { modal: true },
                mergeItem,
                overwriteItem
              );

              if (choice === mergeItem) {
                // Initialize a manifest by scanning current Gist files to ensure they are downloaded
                remoteManifest = {
                  version: "1.0",
                  lastSync: new Date(0).toISOString(),
                  items: [],
                };
                for (const filename of Object.keys(gistFiles)) {
                  if (filename !== MANIFEST_FILENAME) {
                    const localName = filename.endsWith(".md")
                      ? filename
                      : `${filename}.md`;
                    remoteManifest.items.push({
                      id: filename,
                      path: localName.replace(/__/g, "/"),
                      gistFilename: filename,
                      lastModified: Date.now(),
                    });
                  }
                }
              } else if (choice === overwriteItem) {
                // Initialize empty manifest and lastSync as now, so local files will overwrite cloud
                remoteManifest = {
                  version: "1.0",
                  lastSync: new Date().toISOString(),
                  items: [],
                };
              } else {
                // User clicked system Cancel button or closed the dialog
                this.localState.setGistId("");
                vscode.window.showWarningMessage(
                  "Gist connection cancelled. You have been disconnected."
                );
                return;
              }
            } else {
              // Truly empty Gist
              remoteManifest = {
                version: "1.0",
                lastSync: new Date().toISOString(),
                items: [],
              };
            }
          } catch (error: any) {
            const errorMsg = String(error);

            if (errorMsg.includes("404")) {
              this.localState.setGistId("");
              await vscode.window.showErrorMessage(
                "The previously linked Gist was not found (404). Your connection has been reset. Please try syncing again to create a new Gist.",
                { modal: true }
              );
              return;
            }

            const selection = await vscode.window.showErrorMessage(
              `Sync Failed: ${errorMsg}\n\nTroubleshooting:\n1. Ensure your network is stable.\n2. If the Gist is too large, click 'Logout Gist', delete the Gist on GitHub, and start a fresh sync.\n(Note: Your local files are safe and will NOT be deleted.)`,
              { modal: true },
              { title: "Logout Gist" },
              { title: "Open GitHub" },
              { title: "Cancel", isCloseAffordance: true }
            );

            if (selection?.title === "Logout Gist") {
              this.localState.setGistId("");
              vscode.window.showInformationMessage(
                "Gist logged out. Local notes were kept safe."
              );
            } else if (selection?.title === "Open GitHub") {
              vscode.env.openExternal(
                vscode.Uri.parse("https://gist.github.com/mine")
              );
            }
            return;
          }

          // 6. Compute Diff
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({ message: "Calculating differences..." });
          const actions = await this.computeDiff(
            rootPath,
            localFiles,
            remoteManifest!,
            gistFiles
          );

          if (token.isCancellationRequested) {
            return;
          }

          // 7. Execute Actions
          const uploadActions = actions.filter(
            (a) => a.type === "upload" || a.type === "delete"
          );
          const downloadActions = actions.filter(
            (a) => a.type === "download" || a.type === "conflict_gist"
          );

          // Local Ops (Downloads / Conflicts)
          for (const action of downloadActions) {
            if (token.isCancellationRequested) {
              return;
            }

            if (action.type === "conflict_gist") {
              const now = new Date();
              const timestamp = `${now.getFullYear()}-${String(
                now.getMonth() + 1
              ).padStart(2, "0")}-${String(now.getDate()).padStart(
                2,
                "0"
              )} ${String(now.getHours()).padStart(2, "0")}h-${String(
                now.getMinutes()
              ).padStart(2, "0")}m-${String(now.getSeconds()).padStart(
                2,
                "0"
              )}s`;
              const ext = path.extname(action.localPath);
              const conflictPath = path.join(
                path.dirname(action.localPath),
                `${path.basename(
                  action.localPath,
                  ext
                )} (Gist Conflict ${timestamp})${ext}`
              );

              if (action.content) {
                fs.writeFileSync(conflictPath, action.content, "utf8");
                this.localState.updateFileBaseHash(
                  conflictPath,
                  calculateSha1(action.content)
                );
                uploadActions.push({
                  type: "upload",
                  localPath: conflictPath,
                  content: action.content,
                });
              }

              if (action.localContent !== undefined) {
                uploadActions.push({
                  type: "upload",
                  localPath: action.localPath,
                  content: action.localContent,
                });
                this.localState.updateFileBaseHash(
                  action.localPath,
                  calculateSha1(action.localContent)
                );
              }
            } else if (action.type === "download" && action.content) {
              const targetDir = path.dirname(action.localPath);
              if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
              }
              fs.writeFileSync(action.localPath, action.content, "utf8");
              this.localState.updateFileBaseHash(
                action.localPath,
                calculateSha1(action.content)
              );
              if (action.remoteItem) {
                this.localState.updateFileRecord(
                  action.localPath,
                  action.remoteItem.lastModified
                );
              }
            }
          }

          // Remote Ops (Uploads / Deletes with Batching)
          if (uploadActions.length > 0) {
            const totalBatches = Math.ceil(uploadActions.length / BATCH_SIZE);
            for (let i = 0; i < uploadActions.length; i += BATCH_SIZE) {
              if (token.isCancellationRequested) {
                return;
              }

              const batch = uploadActions.slice(i, i + BATCH_SIZE);
              const patchFiles: Record<string, { content: string } | null> = {};

              progress.report({
                message: `Syncing batch ${Math.ceil(
                  (i + 1) / BATCH_SIZE
                )}/${totalBatches}...`,
                increment: (1 / totalBatches) * 100,
              });

              for (const action of batch) {
                if (action.type === "delete" && action.remoteItem) {
                  patchFiles[action.remoteItem.gistFilename] = null;
                  remoteManifest!.items = remoteManifest!.items.filter(
                    (item) => item.id !== action.remoteItem!.id
                  );
                  this.localState.removeRecordById(action.remoteItem.id);
                } else if (
                  action.type === "upload" &&
                  action.content !== undefined &&
                  action.content !== ""
                ) {
                  const id = this.localState.getFileId(action.localPath);
                  const existingItem = remoteManifest?.items.find(
                    (item) => item.id === id
                  );
                  let gistFilename = existingItem
                    ? existingItem.gistFilename
                    : path.basename(action.localPath);

                  if (!existingItem && gistFiles[gistFilename]) {
                    gistFilename = gistFilename.replace(
                      ".md",
                      `-${id.substring(0, 8)}.md`
                    );
                  }

                  patchFiles[gistFilename] = { content: action.content };
                  const relativePath = path.relative(
                    rootPath,
                    action.localPath
                  );
                  const itemIdx = remoteManifest!.items.findIndex(
                    (item) => item.id === id
                  );
                  const newItem: ManifestItem = {
                    id,
                    path: relativePath,
                    gistFilename,
                    lastModified: Date.now(),
                  };

                  if (itemIdx >= 0) remoteManifest!.items[itemIdx] = newItem;
                  else remoteManifest!.items.push(newItem);

                  this.localState.updateFileRecord(
                    action.localPath,
                    newItem.lastModified
                  );
                }
              }

              if (Object.keys(patchFiles).length > 0) {
                await this.gistService.updateGist(gistId!, patchFiles);
              }
            }
          }

          // 8. Final Step: Update Manifest
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({ message: "Updating manifest..." });
          remoteManifest!.lastSync = new Date().toISOString();
          await this.gistService.updateGist(gistId!, {
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

  private async performSizeCheck(files: string[]): Promise<void> {
    let totalSize = 0;
    const largeFiles: string[] = [];

    for (const file of files) {
      if (!fs.existsSync(file)) {
        continue;
      }

      const stats = fs.statSync(file);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > MAX_FILE_SIZE_MB) {
        largeFiles.push(path.basename(file));
      } else {
        totalSize += sizeMB;
      }
    }

    if (largeFiles.length > 0) {
      const message = `The following files exceed the ${MAX_FILE_SIZE_MB}MB limit and will NOT be synced:\n\n${largeFiles.join(
        ", "
      )}\n\nDo you want to continue syncing without these files?`;

      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        "Continue Syncing"
      );

      if (choice !== "Continue Syncing") {
        throw new Error("Sync cancelled due to large files.");
      }
    }

    if (totalSize > MAX_TOTAL_SIZE_MB) {
      const choice = await vscode.window.showWarningMessage(
        `Total sync size (${totalSize.toFixed(
          1
        )}MB) exceeds the recommended limit of ${MAX_TOTAL_SIZE_MB}MB. GitHub Gist may have stability issues with large data. Do you want to continue?`,
        { modal: true },
        "Continue"
      );

      if (choice !== "Continue") {
        throw new Error("Sync cancelled due to total size limit.");
      }
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
        placeHolder: "e.g. 7a...",
      });
    }

    return undefined;
  }
}
