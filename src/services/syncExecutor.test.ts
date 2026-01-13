import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { SyncExecutor, SyncAction } from "./syncExecutor";
import { GistService } from "./gistService";
import { LocalStateManager } from "./localStateManager";
import { Manifest } from "../types";

// Mock dependencies
jest.mock("fs");
jest.mock("path", () => {
  const original = jest.requireActual("path");
  return {
    ...original,
    // We keep actual path logic but we can mock specific behaviors if needed
  };
});
jest.mock("./gistService");
jest.mock("./localStateManager");

const mockedFs = fs as jest.Mocked<typeof fs>;
const MockedGistService = GistService as jest.MockedClass<typeof GistService>;
const MockedLocalState = LocalStateManager as jest.MockedClass<
  typeof LocalStateManager
>;

describe("SyncExecutor", () => {
  let executor: SyncExecutor;
  let gistService: GistService;
  let localState: LocalStateManager;
  let mockToken: vscode.CancellationToken;

  beforeEach(() => {
    jest.clearAllMocks();
    gistService = new MockedGistService() as any;
    localState = new MockedLocalState({} as any) as any;
    executor = new SyncExecutor(gistService, localState);

    mockToken = { isCancellationRequested: false } as any;

    // Default mock behavior for localState
    (localState.getFileId as jest.Mock).mockReturnValue("mock-id");
  });

  describe("processDownloadActions", () => {
    it("should handle download actions", () => {
      const actions: SyncAction[] = [
        {
          type: "download",
          localPath: "/path/to/file.md",
          content: "# Remote Content",
          remoteItem: {
            id: "id1",
            path: "file.md",
            gistFilename: "file.md",
            lastModified: 1000,
          },
        },
      ];

      mockedFs.existsSync.mockReturnValue(true);

      executor.processDownloadActions(actions, mockToken);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/file.md",
        "# Remote Content",
        "utf8"
      );
      expect(localState.updateFileBaseHash).toHaveBeenCalled();
      expect(localState.updateFileRecord).toHaveBeenCalledWith(
        "/path/to/file.md",
        1000
      );
    });

    it("should create directories if they do not exist", () => {
      const actions: SyncAction[] = [
        {
          type: "download",
          localPath: "/new/dir/file.md",
          content: "content",
        },
      ];

      mockedFs.existsSync.mockReturnValue(false);

      executor.processDownloadActions(actions, mockToken);

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith("/new/dir", {
        recursive: true,
      });
    });

    it("should handle conflict_gist actions", () => {
      const actions: SyncAction[] = [
        {
          type: "conflict_gist",
          localPath: "/path/to/file.md",
          content: "# Remote Content",
          localContent: "# Local Content",
        },
      ];

      const additionalUploads = executor.processDownloadActions(
        actions,
        mockToken
      );

      // Verify conflict file was written
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("(Gist Conflict"),
        "# Remote Content",
        "utf8"
      );

      // Verify upload actions were generated
      expect(additionalUploads).toHaveLength(2);
      expect(additionalUploads[0]).toEqual(
        expect.objectContaining({ type: "upload", content: "# Remote Content" })
      );
      expect(additionalUploads[1]).toEqual(
        expect.objectContaining({
          type: "upload",
          localPath: "/path/to/file.md",
          content: "# Local Content",
        })
      );
    });
  });

  describe("processUploadActions", () => {
    let mockProgress: any;

    beforeEach(() => {
      mockProgress = { report: jest.fn() };
    });

    it("should handle upload actions and call gistService", async () => {
      const actions: SyncAction[] = [
        {
          type: "upload",
          localPath: "/path/to/file.md",
          content: "# New Content",
        },
      ];
      const remoteManifest: Manifest = {
        version: "1.0",
        lastSync: "",
        items: [],
      };

      await executor.processUploadActions(
        actions,
        "gist-id",
        "/root",
        remoteManifest,
        {},
        mockProgress,
        mockToken
      );

      expect(gistService.updateGist).toHaveBeenCalledWith("gist-id", {
        "file.md": { content: "# New Content" },
      });
      expect(remoteManifest.items).toHaveLength(1);
    });

    it("should handle delete actions", async () => {
      const actions: SyncAction[] = [
        {
          type: "delete",
          localPath: "/path/to/file.md",
          remoteItem: {
            id: "id1",
            path: "file.md",
            gistFilename: "gist-file.md",
            lastModified: 123,
          },
        },
      ];
      const remoteManifest: Manifest = {
        version: "1.0",
        lastSync: "",
        items: [
          {
            id: "id1",
            path: "file.md",
            gistFilename: "gist-file.md",
            lastModified: 123,
          },
        ],
      };

      await executor.processUploadActions(
        actions,
        "gist-id",
        "/root",
        remoteManifest,
        {},
        mockProgress,
        mockToken
      );

      expect(gistService.updateGist).toHaveBeenCalledWith("gist-id", {
        "gist-file.md": null,
      });
      expect(remoteManifest.items).toHaveLength(0);
      expect(localState.removeRecordById).toHaveBeenCalledWith("id1");
    });

    it("should respect cancellation token", async () => {
      const actions: SyncAction[] = [
        { type: "upload", localPath: "p1", content: "c1" },
      ];
      mockToken.isCancellationRequested = true;

      await executor.processUploadActions(
        actions,
        "id",
        "r",
        { version: "1", items: [] } as any,
        {},
        mockProgress,
        mockToken
      );

      expect(gistService.updateGist).not.toHaveBeenCalled();
    });
  });
});
