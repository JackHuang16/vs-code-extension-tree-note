import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";
import { Manifest, ManifestItem } from "../types";

const MANIFEST_FILENAME = "tree-note-manifest.json";
const MAX_TOTAL_SIZE_MB = 20;
const MAX_FILE_SIZE_MB = 3;
const BATCH_SIZE = 5;

interface SyncAction {
  type: "upload" | "download" | "conflict_rename";
  localPath: string; // Absolute path
  remoteItem?: ManifestItem;
  content?: string;
  reason?: string;
}

export class SyncManager {
  constructor(
    private gistService: GistService,
    private localState: LocalStateManager
  ) {}

  public async sync(rootPath: string): Promise<void> {
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

        try {
          const gist = await this.gistService.getGist(gistId);
          gistFiles = gist.files;
          if (gistFiles[MANIFEST_FILENAME]) {
            try {
              remoteManifest = JSON.parse(gistFiles[MANIFEST_FILENAME].content);
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
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to fetch Gist: ${error}`);
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
          gistFiles,
          this.localState.getLastSyncTime()
        );

        // 6. Execute Actions (Batching)
        const uploadActions = actions.filter((a) => a.type === "upload");
        const downloadActions = actions.filter(
          (a) => a.type === "download" || a.type === "conflict_rename"
        );

        // Handle Conflict Renames & Downloads first (Local operations)
        for (const action of downloadActions) {
          if (action.type === "conflict_rename") {
            // Rename current local file to -Conflict
            const conflictPath = action.localPath.replace(
              ".md",
              " (Local Conflict).md"
            );
            fs.renameSync(action.localPath, conflictPath);
            // Then we let the 'download' logic (which is usually paired or implied) fetch the remote version
            // Actually, if we rename, we need to treat the original path as missing now, so we download the remote content to it.
            if (
              action.remoteItem &&
              gistFiles[action.remoteItem.gistFilename]
            ) {
              fs.writeFileSync(
                action.localPath,
                gistFiles[action.remoteItem.gistFilename].content,
                "utf8"
              );
            }
          } else if (action.type === "download") {
            // New remote file or remote update
            if (
              action.remoteItem &&
              gistFiles[action.remoteItem.gistFilename]
            ) {
              const targetDir = path.dirname(action.localPath);
              if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
              }
              fs.writeFileSync(
                action.localPath,
                gistFiles[action.remoteItem.gistFilename].content,
                "utf8"
              );
              // Update local state to match remote mod time so we don't sync back immediately
              this.localState.updateFileRecord(
                action.localPath,
                action.remoteItem.lastModified
              );
            }
          }
        }

        // Handle Uploads (Remote operations) -> Batching
        if (uploadActions.length > 0) {
          let totalBatches = Math.ceil(uploadActions.length / BATCH_SIZE);
          let currentItem = 0;

          // We accumulate changes for a final Gist Patch, OR we patch in batches?
          // Gist API replaces files in the map. It's safer to do one big PATCH if possible, but user asked for batching.
          // Batching PATCH requests means we make multiple API calls.

          for (let i = 0; i < uploadActions.length; i += BATCH_SIZE) {
            const batch = uploadActions.slice(i, i + BATCH_SIZE);
            const patchFiles: Record<string, { content: string } | null> = {};

            progress.report({
              message: `Uploading batch ${Math.ceil(
                (i + 1) / BATCH_SIZE
              )}/${totalBatches}...`,
              increment: (1 / totalBatches) * 50,
            });

            for (const action of batch) {
              if (!action.content) continue;

              // Determine Gist Filename
              // If it's a new file, we use a readable name + ID if needed?
              // For simplicity now: Use uuid.md or readable-uuid.md
              // The User spec said: "保留可讀檔名，遇到衝突自動加上 -backup" if doing pure name match.
              // But we are using Manifest. So we can use just the UUID or random name in Gist to avoid flattened filename collisions entirely?
              // User said: "Gist is flattened... using uuid to identify... if filename conflict add backup".
              // To keep it simple and clean in Gist view: "Category_NoteName.md" is nice.
              // But to ensure standard uniqueness: We rely on the Manifest.
              // Let's use the local filename. If it exists in Gist (from another file), we append ID.

              let gistFilename = path.basename(action.localPath);
              // Simple collision check against existing Gist files (excluding self)
              // This logic can be refined. For now, let's trust the Manifest mapping.
              // If it's a NEW upload for an existing ID, reuse filename.
              // If it's a NEW ID, check collision.

              const id = this.localState.getFileId(action.localPath);
              const existingItem = remoteManifest?.items.find(
                (item) => item.id === id
              );

              if (existingItem) {
                gistFilename = existingItem.gistFilename;
              } else {
                // New file. Check for collision in gistFiles keys
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
              const relativePath = path.relative(rootPath, action.localPath);
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

              // Update local state lastModified to avoid cycle
              this.localState.updateFileRecord(action.localPath, now);
            }

            // Execute Patch for this batch
            await this.gistService.updateGist(gistId, patchFiles);
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
    gistFiles: any,
    lastSyncTime: number
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    const localProcessedIds = new Set<string>();

    // 1. Check Local Files (Uploads / Updates)
    for (const file of localFiles) {
      const stats = fs.statSync(file);
      // Skip if too large (double check or rely on performSizeCheck behavior? user said "skip and warn".
      // performSizeCheck warns but doesn't return filtered list. Let's filter here.)
      if (stats.size / (1024 * 1024) > MAX_FILE_SIZE_MB) continue;

      const id = this.localState.getFileId(file);
      localProcessedIds.add(id);

      const remoteItem = remoteManifest.items.find((i) => i.id === id);
      const localMtime = stats.mtimeMs;

      if (!remoteItem) {
        // New File -> Upload
        actions.push({
          type: "upload",
          localPath: file,
          content: fs.readFileSync(file, "utf8"),
        });
      } else {
        // Both exist. Check for conflict/update.
        // Note: localState.getSyncItem(file)?.lastModified might be useful if we track "last observed local mtime"
        // But simplified logic: compare with lastSyncTime of the SYSTEM.

        const remoteChanged = remoteItem.lastModified > lastSyncTime;
        const localChanged = localMtime > lastSyncTime;

        if (remoteChanged && localChanged) {
          // Conflict
          actions.push({
            type: "conflict_rename",
            localPath: file,
            remoteItem: remoteItem,
          });
        } else if (localChanged) {
          // Upload
          actions.push({
            type: "upload",
            localPath: file,
            content: fs.readFileSync(file, "utf8"),
          });
        } else if (remoteChanged) {
          // Download (Handled in step 2 loop? No, handled here if we map by ID)
          // Wait, if it exists locally, we process it here.
          actions.push({
            type: "download",
            localPath: file,
            remoteItem: remoteItem,
          });
        }
        // else: synced.
      }
    }

    // 2. Check Remote Files (Downloads of new files)
    for (const item of remoteManifest.items) {
      if (!localProcessedIds.has(item.id)) {
        // Remote exists, Local does not (or is deleted?)
        // If it was deleted locally, we should probably delete remote?
        // For MVP, if local missing, we download (restore).
        // Or we can track deletions if we had a previous snapshot.
        // Current spec doesn't explicitly handle "Delete propagation".
        // Let's assume restoration for now (safer), or ignore?
        // User said: "確認哪些是新增、修改、刪除。"
        // If we want to support delete: we need to know if it WAS there.
        // LocalStateManager has `files` map.

        const localRecord = Object.values(
          this.localState.getFullMap().files
        ).find((f) => f.id === item.id);

        if (localRecord) {
          // We knew about this file, but now it's not on disk. -> Local Delete.
          // Action: Delete Remote? Or Restore Local?
          // Usually Sync restores. Let's Restore Local for safety unless user deletes via UI.
          // But if user deleted it, they want it gone.
          // Issue: we don't know if "missing" means "deleted" or "never synced to this machine".
          // If localRecord exists, it means we synced it before. So it's a delete.
          // Let's Skip (User deleted it).
          // BUT: we need to update Manifest to remove it next time?
          // Complex. Let's just DOWNLOAD (Restore) for safety in this version,
          // or maybe just ignore it (leaving it on Gist).
          // Let's Download it to a new path based on item.path

          const restorePath = path.join(
            rootPath,
            item.path || "restored_note.md"
          );
          actions.push({
            type: "download",
            localPath: restorePath,
            remoteItem: item,
          });
        } else {
          // New Remote File (never seen on this machine) -> Download
          const targetPath = path.join(rootPath, item.path || "downloaded.md");
          actions.push({
            type: "download",
            localPath: targetPath,
            remoteItem: item,
          });
        }
      }
    }

    return actions;
  }

  private async promptForGist(): Promise<string | undefined> {
    const createOption = "Create New Secret Gist";
    const existingOption = "Enter Existing Gist ID";

    const selection = await vscode.window.showQuickPick(
      [createOption, existingOption],
      {
        placeHolder: "Tree Note Cloud Sync Setup",
      }
    );

    if (selection === createOption) {
      const description = await vscode.window.showInputBox({
        prompt: "Enter Gist Description",
        value: "Tree Note Backup",
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
