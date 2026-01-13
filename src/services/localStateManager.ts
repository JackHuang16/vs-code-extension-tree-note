import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { LocalSyncMap, LocalSyncItem } from "../types";

const SYNC_DIR_NAME = "sync-memo";
const SYNC_FILE_NAME = "local-sync-map.json";

export class LocalStateManager {
  private storagePath: string;
  private stateFile: string;
  private state: LocalSyncMap;

  constructor(context: vscode.ExtensionContext) {
    if (!context.globalStorageUri) {
      // Fallback or error handling if global storage is not available (though it usually is)
      throw new Error("Global storage URI not available");
    }
    this.storagePath = path.join(
      context.globalStorageUri.fsPath,
      SYNC_DIR_NAME
    );
    this.stateFile = path.join(this.storagePath, SYNC_FILE_NAME);

    // Default empty state
    this.state = {
      gistId: "",
      lastSyncTime: 0,
      files: {},
    };

    this.initialize();
  }

  private initialize() {
    try {
      if (!fs.existsSync(this.storagePath)) {
        fs.mkdirSync(this.storagePath, { recursive: true });
      }
      this.loadState();
    } catch (error) {
      console.error("Error initializing LocalStateManager:", error);
    }
  }

  private loadState() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const content = fs.readFileSync(this.stateFile, "utf8");
        this.state = JSON.parse(content);
      } catch (error) {
        console.error(
          "Failed to load local sync state, keeping default:",
          error
        );
      }
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify(this.state, null, 2),
        "utf8"
      );
    } catch (error) {
      console.error("Failed to save local sync state:", error);
      vscode.window.showErrorMessage("Tree Note: Failed to save sync state.");
    }
  }

  public getGistId(): string {
    return this.state.gistId;
  }

  public setGistId(gistId: string): void {
    this.state.gistId = gistId;
    this.saveState();
  }

  public getLastSyncTime(): number {
    return this.state.lastSyncTime;
  }

  public setLastSyncTime(time: number): void {
    this.state.lastSyncTime = time;
    this.saveState();
  }

  /**
   * Gets the UUID for a file. If it doesn't exist, generates a new one.
   */
  public getFileId(fsPath: string): string {
    if (!this.state.files[fsPath]) {
      const newId = crypto.randomUUID();
      this.state.files[fsPath] = {
        id: newId,
        lastModified: Date.now(),
      };
      this.saveState();
    }
    return this.state.files[fsPath].id;
  }

  /**
   * Updates the last modified timestamp for a local file record.
   * Ensures an ID exists before updating.
   */
  public updateFileRecord(fsPath: string, lastModified: number): void {
    if (!this.state.files[fsPath]) {
      this.getFileId(fsPath); // Generate ID first
    }
    this.state.files[fsPath].lastModified = lastModified;
    this.saveState();
  }

  public getSyncItem(fsPath: string): LocalSyncItem | undefined {
    return this.state.files[fsPath];
  }

  public getFullMap(): LocalSyncMap {
    return this.state;
  }

  /**
   * Handle file rename/move by updating the key in the map while preserving the ID.
   */
  public handleFileRename(oldFsPath: string, newFsPath: string): void {
    if (this.state.files[oldFsPath]) {
      this.state.files[newFsPath] = this.state.files[oldFsPath];
      delete this.state.files[oldFsPath];
      this.saveState();
    }
  }

  /**
   * Handle file deletion.
   */
  public handleFileDelete(fsPath: string): void {
    if (this.state.files[fsPath]) {
      delete this.state.files[fsPath];
      this.saveState();
    }
  }
}
