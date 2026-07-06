/* Shared types for the yasinc sync engine. */

/** A local file discovered in the vault. Paths are vault-relative, use forward
 * slashes and never start with "/". */
export interface LocalEntry {
  path: string;
  size: number;
  mtime: number;
  /** sha256 hex, computed lazily only when we actually need to compare. */
  hash?: string;
}

/** A file that exists in the target folder on Yandex Disk. */
export interface RemoteEntry {
  path: string; // vault-relative (target folder prefix already stripped)
  size: number;
  sha256: string;
  modified: number; // ms since epoch
}

/** What was true at the end of the previous successful sync, per path. */
export interface SnapshotEntry {
  hash: string;
  size: number;
  /** Local mtime at snapshot time — lets us skip re-hashing unchanged files. */
  mtime: number;
}

/** Persisted between runs so we can tell "deleted" apart from "new elsewhere". */
export interface Snapshot {
  version: number;
  /** Which Disk folder this snapshot describes; a change invalidates it. */
  remoteFolder: string;
  syncedAt: number;
  /** Global Disk revision at last sync; if unchanged, skip the remote walk. */
  diskRevision?: number;
  /** Random per-device id. A snapshot whose id doesn't match this device was
   * copied here from another machine (e.g. via a manual .obsidian copy) and
   * MUST NOT be trusted — otherwise every not-yet-present file looks "deleted
   * locally" and the sync wipes both sides. */
  installId?: string;
  entries: Record<string, SnapshotEntry>;
}

export const SNAPSHOT_VERSION = 1;

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  errors: string[];
  /** Human-readable list of what happened, for the sync log modal. */
  log: string[];
}

export function emptyStats(): SyncStats {
  return {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skipped: 0,
    errors: [],
    log: [],
  };
}
