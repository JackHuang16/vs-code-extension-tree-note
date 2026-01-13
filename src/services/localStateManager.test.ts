import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { LocalStateManager } from "./localStateManager";

// Mock fs
jest.mock("fs");
const mockedFs = fs as jest.Mocked<typeof fs>;

// Mock vscode
const mockedVscode = vscode as any;

describe("LocalStateManager", () => {
  let context: any;
  let manager: LocalStateManager;
  const storagePath = "/mock/sync-memo";
  const stateFile = path.join(storagePath, "local-sync-map.json");

  beforeEach(() => {
    jest.clearAllMocks();

    context = {
      globalStorageUri: {
        fsPath: "/mock",
      },
    };

    mockedFs.existsSync.mockReturnValue(false);
    manager = new LocalStateManager(context);
  });

  describe("initialization", () => {
    it("should create storage directory if it does not exist", () => {
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("sync-memo"),
        { recursive: true }
      );
    });

    it("should load state if state file exists", () => {
      mockedFs.existsSync.mockImplementation((p: any) => p === stateFile);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ gistId: "saved-id", files: {} })
      );

      const newManager = new LocalStateManager(context);
      expect(newManager.getGistId()).toBe("saved-id");
    });
  });

  describe("state management", () => {
    it("should set and save gistId", () => {
      manager.setGistId("new-gist-id");
      expect(manager.getGistId()).toBe("new-gist-id");
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("new-gist-id"),
        "utf8"
      );
    });

    it("should handle file records", () => {
      const fsPath = "/path/to/note.md";
      const id = manager.getFileId(fsPath);

      expect(id).toBeDefined();
      expect(manager.getSyncItem(fsPath)?.id).toBe(id);

      manager.updateFileRecord(fsPath, 12345);
      expect(manager.getSyncItem(fsPath)?.lastModified).toBe(12345);
    });

    it("should handle file rename", () => {
      const oldPath = "/old.md";
      const newPath = "/new.md";
      const id = manager.getFileId(oldPath);

      manager.handleFileRename(oldPath, newPath);

      expect(manager.getSyncItem(oldPath)).toBeUndefined();
      expect(manager.getSyncItem(newPath)?.id).toBe(id);
    });

    it("should handle file delete (tombstone)", () => {
      const fsPath = "/delete.md";
      manager.getFileId(fsPath);

      manager.handleFileDelete(fsPath);

      expect(manager.getSyncItem(fsPath)?.deleted).toBe(true);
    });

    it("should remove record by id", () => {
      const fsPath = "/remove.md";
      const id = manager.getFileId(fsPath);

      manager.removeRecordById(id);

      expect(manager.getSyncItem(fsPath)).toBeUndefined();
    });

    it("should update file base hash", () => {
      const fsPath = "/hash.md";
      manager.updateFileBaseHash(fsPath, "sha-hash");

      expect(manager.getSyncItem(fsPath)?.baseHash).toBe("sha-hash");
    });
  });
});
