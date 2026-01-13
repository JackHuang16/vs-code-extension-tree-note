import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SyncManager } from "./syncManager";
import { MANIFEST_FILENAME } from "../constants";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";

// Mock dependencies
jest.mock("fs");
jest.mock("./gistService");
jest.mock("./localStateManager");
jest.mock("../utils/cryptoUtils", () => ({
  calculateSha1: jest.fn((content) => `hash-${content}`),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const MockedGistService = GistService as jest.MockedClass<typeof GistService>;
const MockedLocalState = LocalStateManager as jest.MockedClass<
  typeof LocalStateManager
>;
const mockedVscode = vscode as any;

describe("SyncManager", () => {
  let manager: SyncManager;
  let gistService: GistService;
  let localState: LocalStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
    gistService = new MockedGistService() as any;
    localState = new MockedLocalState({} as any) as any;
    manager = new SyncManager(gistService, localState);

    // Setup default mocks
    (localState.getGistId as jest.Mock).mockReturnValue("existing-gist-id");
    (localState.getFullMap as jest.Mock).mockReturnValue({ files: {} });
    (gistService.getGist as jest.Mock).mockResolvedValue({
      id: "existing-gist-id",
      public: false,
      files: {
        [MANIFEST_FILENAME]: {
          content: JSON.stringify({ version: "1.0", lastSync: "", items: [] }),
        },
      },
    });

    // Mock vscode.window.withProgress
    mockedVscode.window.withProgress.mockImplementation(
      (options: any, callback: any) => {
        const progress = { report: jest.fn() };
        const token = { isCancellationRequested: false };
        return callback(progress, token);
      }
    );
  });

  describe("sync", () => {
    it("should complete a basic sync successfully", async () => {
      const rootPath = "/notes";
      const filePath = path.join(rootPath, "note1.md");

      // Mock fs for scanLocalFiles
      mockedFs.existsSync.mockImplementation(
        (p: any) => p === rootPath || p === filePath
      );
      mockedFs.statSync.mockImplementation((p: any) => {
        if (p === rootPath)
          return {
            isDirectory: () => true,
            isFile: () => false,
            size: 0,
          } as any;
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 1024,
        } as any;
      });
      mockedFs.readdirSync.mockImplementation((p: any) => {
        if (p === rootPath) return ["note1.md"] as any;
        return [] as any;
      });
      mockedFs.readFileSync.mockReturnValue("# Content");

      (localState.getFileId as jest.Mock).mockReturnValue("id1");
      (localState.getSyncItem as jest.Mock).mockReturnValue({
        id: "id1",
        lastModified: 1000,
        baseHash: "old-hash",
      });

      // Mock updateGist to return a resolved promise
      (gistService.updateGist as jest.Mock).mockResolvedValue({});

      await manager.sync(rootPath);

      // Verify progress was shown
      expect(mockedVscode.window.withProgress).toHaveBeenCalled();

      // Verify gist interactions
      expect(gistService.getGist).toHaveBeenCalledWith("existing-gist-id");
      expect(gistService.updateGist).toHaveBeenCalled();
      expect(mockedVscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Tree Note synchronization complete!"
      );
    });

    it("should reset gistId if gist is public", async () => {
      (gistService.getGist as jest.Mock).mockResolvedValue({
        id: "public-gist",
        public: true,
        files: {},
      });

      await manager.sync("/root");

      expect(localState.setGistId).toHaveBeenCalledWith("");
      expect(mockedVscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("only supports using Secret Gists"),
        { modal: true }
      );
    });

    it("should handle 404 from gist service by resetting gistId", async () => {
      (gistService.getGist as jest.Mock).mockRejectedValue(
        new Error("GitHub API request failed: 404 Not Found")
      );
      (mockedVscode.window.showQuickPick as jest.Mock).mockResolvedValue(null);

      // Empty scan results
      mockedFs.existsSync.mockReturnValue(false);

      await manager.sync("/root");

      expect(localState.setGistId).toHaveBeenCalledWith("");
    });
  });
});
