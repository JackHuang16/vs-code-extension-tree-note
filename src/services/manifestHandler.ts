import * as vscode from "vscode";
import { Manifest, ManifestItem } from "../types";
import { MANIFEST_FILENAME } from "../constants";

/**
 * Result of manifest initialization process.
 */
export interface ManifestInitResult {
  success: boolean;
  manifest: Manifest | null;
  shouldDisconnect?: boolean;
}

/**
 * Creates a new empty manifest with default values.
 * @param useCurrentTime - If true, uses current time as lastSync; otherwise uses epoch time
 * @returns A new empty Manifest object
 */
export function createEmptyManifest(useCurrentTime: boolean = false): Manifest {
  return {
    version: "1.0",
    lastSync: useCurrentTime
      ? new Date().toISOString()
      : new Date(0).toISOString(),
    items: [],
  };
}

/**
 * Parses manifest from Gist files with error handling.
 * @param gistFiles - The files object from Gist API response
 * @returns Parsed manifest or null if parsing failed
 */
export function parseManifestFromContent(content: string): Manifest | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Builds a manifest from existing Gist files (for migration/merge scenarios).
 * @param gistFiles - The files object from Gist API response
 * @returns A new manifest with items for each existing file
 */
export function buildManifestFromExistingFiles(
  gistFiles: Record<string, { content: string }>
): Manifest {
  const manifest = createEmptyManifest(false);

  for (const filename of Object.keys(gistFiles)) {
    if (filename !== MANIFEST_FILENAME) {
      const localName = filename.endsWith(".md") ? filename : `${filename}.md`;
      manifest.items.push({
        id: filename,
        path: localName.replace(/__/g, "/"),
        gistFilename: filename,
        lastModified: Date.now(),
      });
    }
  }

  return manifest;
}

/**
 * Handles manifest initialization for various Gist states.
 * @param gistFiles - The files object from Gist API response
 * @returns Result object with manifest or instructions
 */
export async function initializeManifestFromGist(
  gistFiles: Record<string, { content: string }>
): Promise<ManifestInitResult> {
  const hasExistingFiles = Object.keys(gistFiles).some(
    (name) => name !== MANIFEST_FILENAME
  );

  // Case 1: Manifest exists - parse it
  if (gistFiles[MANIFEST_FILENAME]) {
    const manifest = parseManifestFromContent(
      gistFiles[MANIFEST_FILENAME].content
    );

    if (manifest) {
      return { success: true, manifest };
    }

    // Manifest is corrupted - prompt user
    const choice = await vscode.window.showErrorMessage(
      "Cloud settings (manifest.json) corrupted. How would you like to proceed?",
      { modal: true },
      { title: "Overwrite Cloud", isCloseAffordance: false },
      { title: "Cancel", isCloseAffordance: true }
    );

    if (choice?.title !== "Overwrite Cloud") {
      return { success: false, manifest: null };
    }

    return { success: true, manifest: createEmptyManifest(false) };
  }

  // Case 2: No manifest but has files - ask user what to do
  if (hasExistingFiles) {
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
      return {
        success: true,
        manifest: buildManifestFromExistingFiles(gistFiles),
      };
    }

    if (choice === overwriteItem) {
      return { success: true, manifest: createEmptyManifest(true) };
    }

    // User cancelled
    return { success: false, manifest: null, shouldDisconnect: true };
  }

  // Case 3: Empty Gist - create new manifest
  return { success: true, manifest: createEmptyManifest(true) };
}
