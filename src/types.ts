export interface ManifestItem {
  id: string;
  path: string; // Logical path in Tree Note (e.g., /folder/note.md)
  gistFilename: string;
  lastModified: number;
}

export interface Manifest {
  version: string;
  lastSync: string; // ISO date string
  items: ManifestItem[];
}

export interface LocalSyncItem {
  id: string;
  lastModified: number;
  baseHash?: string; // SHA-1 hash of the content at last sync
  deleted?: boolean;
}

export interface LocalSyncMap {
  gistId: string; // The ID of the Gist we are syncing with
  lastSyncTime: number;
  files: { [fsPath: string]: LocalSyncItem }; // Map absolute fsPath to sync info
}
