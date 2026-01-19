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
} from "../constants";
import { calculateSha1 } from "../utils/cryptoUtils";
import { initializeManifestFromGist } from "./manifestHandler";
import { SyncExecutor, SyncAction } from "./syncExecutor";

export class SyncManager {
  public isSyncing = false;

  constructor(
    private gistService: GistService,
    private localState: LocalStateManager,
  ) {}

  public async sync(rootPath: string): Promise<void> {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;

    try {
      // 1. Local Pre-check
      const localFiles = this.scanLocalFiles(rootPath);
      try {
        await this.performSizeCheck(localFiles);
      } catch (e: any) {
        return;
      }

      // 2. Gist Connection & Identification
      let gistId = await this.ensureGistConnection();
      if (!gistId) {
        return;
      }

      // 3. Official Sync with Progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tree Note Sync",
          cancellable: true,
        },
        async (progress, token) => {
          if (token.isCancellationRequested) return;

          progress.report({ message: "Connecting to Gist..." });

          // 4. Fetch Remote & Initialize Manifest
          let remoteManifest: Manifest | null = null;
          let gistFiles: any = {};

          try {
            const gist = await this.gistService.getGist(gistId!);
            if (token.isCancellationRequested) return;

            // Security Check
            if (gist.public) {
              this.localState.setGistId("");
              await vscode.window.showErrorMessage(
                "For privacy reasons, Tree Note only supports using Secret Gists. The linked Gist is currently Public. Please re-sync and create/select a Secret Gist.",
                { modal: true },
              );
              return;
            }

            gistFiles = gist.files;
            const initResult = await initializeManifestFromGist(gistFiles);

            if (!initResult.success) {
              if (initResult.shouldDisconnect) {
                this.localState.setGistId("");
                vscode.window.showWarningMessage(
                  "Gist connection cancelled. You have been disconnected.",
                );
              }
              return;
            }
            remoteManifest = initResult.manifest;
          } catch (error: any) {
            await this.handleConnectionError(error);
            return;
          }

          if (!remoteManifest) return;

          // 5. Compute Diff
          if (token.isCancellationRequested) return;
          progress.report({ message: "Calculating differences..." });

          const actions = await this.computeDiff(
            rootPath,
            localFiles,
            remoteManifest,
            gistFiles,
          );

          if (token.isCancellationRequested) return;

          // 6. Execute Actions
          const syncExecutor = new SyncExecutor(
            this.gistService,
            this.localState,
          );

          const uploadActions = actions.filter(
            (a) => a.type === "upload" || a.type === "delete",
          );
          const downloadActions = actions.filter(
            (a) => a.type === "download" || a.type === "conflict_gist",
          );

          // Process Downloads (may generate conflict uploads)
          const conflictUploads = syncExecutor.processDownloadActions(
            downloadActions,
            token,
          );
          if (token.isCancellationRequested) return;

          uploadActions.push(...conflictUploads);

          // Process Uploads (Batching)
          if (uploadActions.length > 0) {
            await syncExecutor.processUploadActions(
              uploadActions,
              gistId!,
              rootPath,
              remoteManifest,
              gistFiles,
              progress,
              token,
            );
          }

          // 7. Final Step: Update Manifest
          if (token.isCancellationRequested) return;
          progress.report({ message: "Updating manifest..." });

          remoteManifest.lastSync = new Date().toISOString();
          await this.gistService.updateGist(gistId!, {
            [MANIFEST_FILENAME]: {
              content: JSON.stringify(remoteManifest, null, 2),
            },
          });

          this.localState.setLastSyncTime(Date.now());
          vscode.window.showInformationMessage(
            "Tree Note synchronization complete!",
          );
        },
      );
    } finally {
      this.isSyncing = false;
    }
  }

  private async ensureGistConnection(): Promise<string | undefined> {
    let gistId = this.localState.getGistId();

    if (gistId) {
      try {
        await this.gistService.getGist(gistId);
      } catch (error: any) {
        if (String(error).includes("404")) {
          this.localState.setGistId("");
          gistId = "";
          vscode.window.showWarningMessage(
            "The linked Gist no longer exists. Please reconnect.",
          );
        } else {
          throw error;
        }
      }
    }

    if (!gistId) {
      const resultId = await this.promptForGist();
      if (!resultId) return undefined;
      gistId = resultId;
      this.localState.setGistId(gistId);
    }

    return gistId;
  }

  private async handleConnectionError(error: any): Promise<void> {
    const errorMsg = String(error);

    if (errorMsg.includes("404")) {
      this.localState.setGistId("");
      await vscode.window.showErrorMessage(
        "The previously linked Gist was not found (404). Your connection has been reset. Please try syncing again.",
        { modal: true },
      );
      return;
    }

    const selection = await vscode.window.showErrorMessage(
      `Sync Failed: ${errorMsg}\n\nTroubleshooting:\n1. Network stable?\n2. Gist too large? Try 'Logout Gist' and clean up.`,
      { modal: true },
      { title: "Logout Gist" },
      { title: "Open GitHub" },
      { title: "Cancel", isCloseAffordance: true },
    );

    if (selection?.title === "Logout Gist") {
      this.localState.setGistId("");
      vscode.window.showInformationMessage(
        "Gist logged out. Local notes safe.",
      );
    } else if (selection?.title === "Open GitHub") {
      vscode.env.openExternal(vscode.Uri.parse("https://gist.github.com/mine"));
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
          if (child.startsWith(".")) continue;
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
      if (!fs.existsSync(file)) continue;
      const stats = fs.statSync(file);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > MAX_FILE_SIZE_MB) {
        largeFiles.push(path.basename(file));
      } else {
        totalSize += sizeMB;
      }
    }

    if (largeFiles.length > 0) {
      const message = `Files exceeding ${MAX_FILE_SIZE_MB}MB limit will NOT be synced:\n\n${largeFiles.join(
        ", ",
      )}\n\nContinue?`;
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        "Continue Syncing",
      );
      if (choice !== "Continue Syncing") {
        throw new Error("Sync cancelled due to large files.");
      }
    }

    if (totalSize > MAX_TOTAL_SIZE_MB) {
      const choice = await vscode.window.showWarningMessage(
        `Total sync size (${totalSize.toFixed(
          1,
        )}MB) exceeds recommended ${MAX_TOTAL_SIZE_MB}MB. Continue?`,
        { modal: true },
        "Continue",
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
    gistFiles: any,
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    const localProcessedIds = new Set<string>();

    // 1. Check Local Files
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
        actions.push({
          type: "upload",
          localPath: file,
          content: localContent,
        });
      } else {
        // 3-Way Merge
        if (localHash === remoteHash) continue;

        if (localHash === baseHash && remoteHash !== baseHash) {
          actions.push({
            type: "download",
            localPath: file,
            content: remoteContent!,
            remoteItem: remoteItem,
          });
        } else if (localHash !== baseHash && remoteHash === baseHash) {
          actions.push({
            type: "upload",
            localPath: file,
            content: localContent,
          });
        } else {
          actions.push({
            type: "conflict_gist",
            localPath: file,
            remoteItem: remoteItem,
            content: remoteContent!,
            localContent: localContent,
          });
        }
      }
    }

    // 2. Check Remote Items
    const localMapValues = Object.values(this.localState.getFullMap().files);

    for (const item of remoteManifest.items) {
      if (localProcessedIds.has(item.id)) continue;

      const localRecord = localMapValues.find((f) => f.id === item.id);
      if (localRecord && localRecord.deleted) {
        actions.push({ type: "delete", localPath: "", remoteItem: item });
        continue;
      }

      let shouldDelete = false;
      if (gistFiles[item.gistFilename]) {
        const remoteContent = gistFiles[item.gistFilename].content || "";
        if (localRecord?.baseHash) {
          const remoteHash = calculateSha1(remoteContent);
          if (remoteHash === localRecord.baseHash) {
            shouldDelete = true;
          }
        }
      }

      if (shouldDelete) {
        actions.push({ type: "delete", localPath: "", remoteItem: item });
      } else if (gistFiles[item.gistFilename]) {
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

    const selection = await vscode.window.showQuickPick(
      [createOption, existingOption],
      {
        placeHolder:
          "Tree Note Cloud Sync: Choose how to sync with GitHub Gist",
        ignoreFocusOut: true,
      },
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
