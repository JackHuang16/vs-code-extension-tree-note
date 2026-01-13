import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";
import { Manifest, ManifestItem } from "../types";
import { BATCH_SIZE } from "../constants";
import { calculateSha1 } from "../utils/cryptoUtils";
import { generateConflictTimestamp } from "../utils/formatUtils";

/**
 * Represents a synchronization action to be executed.
 */
export interface SyncAction {
  type: "upload" | "download" | "conflict_gist" | "delete";
  localPath: string;
  remoteItem?: ManifestItem;
  content?: string;
  localContent?: string;
  reason?: string;
}

/**
 * Handles execution of synchronization actions.
 */
export class SyncExecutor {
  constructor(
    private gistService: GistService,
    private localState: LocalStateManager
  ) {}

  /**
   * Processes download and conflict actions.
   * Returns additional upload actions generated from conflict resolution.
   */
  public processDownloadActions(
    downloadActions: SyncAction[],
    token: vscode.CancellationToken
  ): SyncAction[] {
    const additionalUploadActions: SyncAction[] = [];

    for (const action of downloadActions) {
      if (token.isCancellationRequested) {
        break;
      }

      if (action.type === "conflict_gist") {
        const conflictUploads = this.handleConflictAction(action);
        additionalUploadActions.push(...conflictUploads);
      } else if (action.type === "download" && action.content) {
        this.handleDownloadAction(action);
      }
    }

    return additionalUploadActions;
  }

  /**
   * Handles a conflict action by creating a conflict file and preparing uploads.
   */
  private handleConflictAction(action: SyncAction): SyncAction[] {
    const uploadActions: SyncAction[] = [];
    const timestamp = generateConflictTimestamp();
    const ext = path.extname(action.localPath);
    const conflictPath = path.join(
      path.dirname(action.localPath),
      `${path.basename(
        action.localPath,
        ext
      )} (Gist Conflict ${timestamp})${ext}`
    );

    // Write the remote content to conflict file
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

    // Queue local content for upload (to overwrite remote)
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

    return uploadActions;
  }

  /**
   * Handles a download action by writing the file to disk.
   */
  private handleDownloadAction(action: SyncAction): void {
    const targetDir = path.dirname(action.localPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(action.localPath, action.content!, "utf8");
    this.localState.updateFileBaseHash(
      action.localPath,
      calculateSha1(action.content!)
    );

    if (action.remoteItem) {
      this.localState.updateFileRecord(
        action.localPath,
        action.remoteItem.lastModified
      );
    }
  }

  /**
   * Processes upload and delete actions in batches.
   */
  public async processUploadActions(
    uploadActions: SyncAction[],
    gistId: string,
    rootPath: string,
    remoteManifest: Manifest,
    gistFiles: Record<string, { content: string }>,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (uploadActions.length === 0) {
      return;
    }

    const totalBatches = Math.ceil(uploadActions.length / BATCH_SIZE);

    for (let i = 0; i < uploadActions.length; i += BATCH_SIZE) {
      if (token.isCancellationRequested) {
        return;
      }

      const batch = uploadActions.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.ceil((i + 1) / BATCH_SIZE);

      progress.report({
        message: `Syncing batch ${batchNumber}/${totalBatches}...`,
        increment: (1 / totalBatches) * 100,
      });

      const patchFiles = this.processBatch(
        batch,
        rootPath,
        remoteManifest,
        gistFiles
      );

      if (Object.keys(patchFiles).length > 0) {
        await this.gistService.updateGist(gistId, patchFiles);
      }
    }
  }

  /**
   * Processes a single batch of actions and returns the patch files.
   */
  private processBatch(
    batch: SyncAction[],
    rootPath: string,
    remoteManifest: Manifest,
    gistFiles: Record<string, { content: string }>
  ): Record<string, { content: string } | null> {
    const patchFiles: Record<string, { content: string } | null> = {};

    for (const action of batch) {
      if (action.type === "delete" && action.remoteItem) {
        this.processDeleteAction(action, remoteManifest, patchFiles);
      } else if (this.isValidUploadAction(action)) {
        this.processUploadAction(
          action,
          rootPath,
          remoteManifest,
          gistFiles,
          patchFiles
        );
      }
    }

    return patchFiles;
  }

  /**
   * Checks if an action is a valid upload action.
   */
  private isValidUploadAction(action: SyncAction): boolean {
    return (
      action.type === "upload" &&
      action.content !== undefined &&
      action.content !== ""
    );
  }

  /**
   * Processes a delete action.
   */
  private processDeleteAction(
    action: SyncAction,
    remoteManifest: Manifest,
    patchFiles: Record<string, { content: string } | null>
  ): void {
    patchFiles[action.remoteItem!.gistFilename] = null;
    remoteManifest.items = remoteManifest.items.filter(
      (item) => item.id !== action.remoteItem!.id
    );
    this.localState.removeRecordById(action.remoteItem!.id);
  }

  /**
   * Processes an upload action.
   */
  private processUploadAction(
    action: SyncAction,
    rootPath: string,
    remoteManifest: Manifest,
    gistFiles: Record<string, { content: string }>,
    patchFiles: Record<string, { content: string } | null>
  ): void {
    const id = this.localState.getFileId(action.localPath);
    const existingItem = remoteManifest.items.find((item) => item.id === id);
    let gistFilename = existingItem
      ? existingItem.gistFilename
      : path.basename(action.localPath);

    // Handle filename collision
    if (!existingItem && gistFiles[gistFilename]) {
      gistFilename = gistFilename.replace(".md", `-${id.substring(0, 8)}.md`);
    }

    patchFiles[gistFilename] = { content: action.content! };

    const relativePath = path.relative(rootPath, action.localPath);
    const newItem: ManifestItem = {
      id,
      path: relativePath,
      gistFilename,
      lastModified: Date.now(),
    };

    const itemIndex = remoteManifest.items.findIndex((item) => item.id === id);

    if (itemIndex >= 0) {
      remoteManifest.items[itemIndex] = newItem;
    } else {
      remoteManifest.items.push(newItem);
    }

    this.localState.updateFileRecord(action.localPath, newItem.lastModified);
  }
}
