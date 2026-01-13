import * as vscode from "vscode";
import {
  createEmptyManifest,
  parseManifestFromContent,
  buildManifestFromExistingFiles,
  initializeManifestFromGist,
} from "./manifestHandler";
import { MANIFEST_FILENAME } from "../constants";

// We need to cast the mocked objects to access jest.fn() methods
const mockedWindow = vscode.window as any;

describe("manifestHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createEmptyManifest", () => {
    it("should create an empty manifest with epoch zero by default", () => {
      const manifest = createEmptyManifest();
      expect(manifest.version).toBe("1.0");
      expect(manifest.lastSync).toBe(new Date(0).toISOString());
      expect(manifest.items).toEqual([]);
    });

    it("should create an empty manifest with current time if useCurrentTime is true", () => {
      const manifest = createEmptyManifest(true);
      const now = new Date().toISOString();
      // Check if the timestamp is close to current time (within 1 second)
      expect(new Date(manifest.lastSync).getTime()).toBeGreaterThan(
        Date.now() - 1000
      );
    });
  });

  describe("parseManifestFromContent", () => {
    it("should parse valid JSON", () => {
      const content =
        '{"version": "1.0", "lastSync": "2024-01-01", "items": []}';
      const result = parseManifestFromContent(content);
      expect(result).toEqual({
        version: "1.0",
        lastSync: "2024-01-01",
        items: [],
      });
    });

    it("should return null for invalid JSON", () => {
      const result = parseManifestFromContent("invalid json");
      expect(result).toBeNull();
    });
  });

  describe("buildManifestFromExistingFiles", () => {
    it("should build a manifest from gist files", () => {
      const gistFiles = {
        "folder__file.md": { content: "content" },
        "another-file": { content: "content" },
        [MANIFEST_FILENAME]: { content: "{}" },
      };

      const manifest = buildManifestFromExistingFiles(gistFiles);

      expect(manifest.items).toHaveLength(2);
      expect(manifest.items).toContainEqual(
        expect.objectContaining({
          id: "folder__file.md",
          path: "folder/file.md",
          gistFilename: "folder__file.md",
        })
      );
      expect(manifest.items).toContainEqual(
        expect.objectContaining({
          id: "another-file",
          path: "another-file.md",
          gistFilename: "another-file",
        })
      );
    });
  });

  describe("initializeManifestFromGist", () => {
    it("should return existing manifest if it exists and is valid", async () => {
      const validManifest = {
        version: "1.0",
        lastSync: "2024-01-01",
        items: [],
      };
      const gistFiles = {
        [MANIFEST_FILENAME]: { content: JSON.stringify(validManifest) },
      };

      const result = await initializeManifestFromGist(gistFiles);

      expect(result.success).toBe(true);
      expect(result.manifest).toEqual(validManifest);
    });

    it("should handle corrupted manifest and user choosing to overwrite", async () => {
      const gistFiles = {
        [MANIFEST_FILENAME]: { content: "corrupted" },
      };

      mockedWindow.showErrorMessage.mockResolvedValue({
        title: "Overwrite Cloud",
      });

      const result = await initializeManifestFromGist(gistFiles);

      expect(result.success).toBe(true);
      expect(result.manifest?.lastSync).toBe(new Date(0).toISOString());
      expect(mockedWindow.showErrorMessage).toHaveBeenCalled();
    });

    it("should handle corrupted manifest and user choosing to cancel", async () => {
      const gistFiles = {
        [MANIFEST_FILENAME]: { content: "corrupted" },
      };

      mockedWindow.showErrorMessage.mockResolvedValue({ title: "Cancel" });

      const result = await initializeManifestFromGist(gistFiles);

      expect(result.success).toBe(false);
      expect(result.manifest).toBeNull();
    });

    it("should offer to merge when no manifest but files exist", async () => {
      const gistFiles = {
        "file1.md": { content: "content" },
      };

      // Mock user selecting Merge
      mockedWindow.showWarningMessage.mockImplementation(
        (msg: string, config: any, ...items: any[]) => {
          return Promise.resolve(items[0]); // Return the first item (Merge)
        }
      );

      const result = await initializeManifestFromGist(gistFiles);

      expect(result.success).toBe(true);
      expect(result.manifest?.items).toHaveLength(1);
      expect(mockedWindow.showWarningMessage).toHaveBeenCalled();
    });

    it("should create new manifest for empty gist", async () => {
      const result = await initializeManifestFromGist({});

      expect(result.success).toBe(true);
      expect(new Date(result.manifest!.lastSync).getTime()).toBeGreaterThan(
        Date.now() - 1000
      );
    });
  });
});
