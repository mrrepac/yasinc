/*
 * Three-way sync engine.
 *
 * For every path we compare three states:
 *   L = the file in the local vault now
 *   R = the file in the target folder on Yandex Disk now
 *   B = the file as it was at the end of the previous successful sync (snapshot)
 *
 * The snapshot is what lets us tell "deleted on the other side" apart from
 * "newly created on this side". Comparisons are by sha256. When both sides
 * changed a file in different ways we never overwrite silently — we keep both
 * copies (a ".conflict-…" file). Deletions go to the trash, not oblivion.
 *
 * Speed:
 *  - a persistent hash cache (hash-cache.json) means a file is hashed once and
 *    then skipped as long as its mtime+size are unchanged; the cache is saved
 *    incrementally so an interrupted first sync doesn't force a full re-hash;
 *  - the remote side is listed with one flat paginated call, not a per-folder
 *    tree walk;
 *  - hashing and upload/download run through a small concurrency pool.
 */

import { App, DataAdapter, Platform, normalizePath } from "obsidian";
import { YandexDisk } from "./yandex";
import { sha256Hex } from "./hash";
import { Excluder } from "./exclude";
import {
  LocalEntry,
  RemoteEntry,
  Snapshot,
  SNAPSHOT_VERSION,
  SyncStats,
  emptyStats,
} from "./types";
import { BUILT_IN_EXCLUDES } from "./settings";
import type { YasincSettings } from "./settings";

type OpType = "upload" | "download" | "delLocal" | "delRemote" | "conflict";

interface Op {
  type: OpType;
  path: string;
  /** For an overwrite-upload: the remote sha256 we planned against. Before
   * overwriting we re-check the Disk; if it no longer matches, the remote
   * changed under us (another device) and we divert to a conflict instead of
   * clobbering it. */
  guard?: string;
}

interface CacheEntry {
  mtime: number;
  size: number;
  hash: string;
}

export interface SyncProgress {
  done: number;
  total: number;
  path: string;
  phase: "scan" | "hash" | "apply";
  /** During "apply": which kind of operation this file is undergoing. */
  op?: OpType;
}

export interface SyncOptions {
  onProgress?: (p: SyncProgress) => void;
  signal?: { aborted: boolean };
  /** Force a real remote walk, bypassing the revision fast path. Used for the
   * periodic reconciliation that catches changes made on the Disk while an
   * earlier run was mid-flight (which the fast path would otherwise mask). */
  forceRemoteWalk?: boolean;
  /** Skip the bulk-delete guard for this run (user confirmed the deletions). */
  allowBulkDelete?: boolean;
}

/**
 * Thrown BEFORE any operation is applied when a run plans to delete a
 * suspicious number of files. This is the last line of defence against a
 * catastrophe like a foreign sync-state.json (copied from another device)
 * making every note look "deleted locally" and wiping both sides.
 */
export class BulkDeleteError extends Error {
  constructor(
    public readonly count: number,
    public readonly total: number,
    public readonly samples: string[]
  ) {
    super(`bulk-delete guard: ${count} of ${total}`);
    this.name = "BulkDeleteError";
  }
}

/** Never flag fewer than this many deletions — small cleanups are normal. */
const BULK_DELETE_MIN = 20;
/** …and only when they're this fraction of everything we know about. */
const BULK_DELETE_FRACTION = 0.3;

/**
 * Concurrency for network ops and local hashing. Every in-flight transfer
 * holds a whole file in memory (requestUrl has no streaming), so on mobile —
 * where memory is tight and a native OOM crashes the whole app — we go one at
 * a time. A vault with 40–56 MB audio files would otherwise blow up.
 */
const NET_CONCURRENCY = Platform.isMobile ? 1 : 6;
const HASH_CONCURRENCY = Platform.isMobile ? 2 : 8;

/** Re-walk the remote at least this often even if the revision looks unchanged,
 * so a write masked during an earlier run can't hide forever. */
const RECONCILE_MS = 10 * 60 * 1000;

function normalizeFolder(folder: string): string {
  return (folder || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, items.length);
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) break;
          await fn(items[i], i);
        }
      })()
    );
  }
  await Promise.all(workers);
}

export class SyncEngine {
  private adapter: DataAdapter;
  private remoteFolder: string;
  private excluder: Excluder;
  private snapshot: Snapshot;

  /**
   * Hash cache, mirrored to hash-cache.json. Entries are validated by
   * mtime+size on every lookup — NEVER add a lookup keyed by path alone: the
   * engine lives for the whole session, so a stale path→hash shortcut would
   * mask repeat edits of the same file ("unchanged") and silently drop them.
   */
  private persistentCache: Record<string, CacheEntry> = {};
  private cacheDirty = 0;
  private cacheSaving = false;
  private snapSaving = false;
  private ensured = new Set<string>();
  private currentDiskRevision: number | null = null;
  private loaded = false;
  /** Size cap in bytes; files above it are invisible to sync (Infinity = off). */
  private limitBytes: number;
  /** Paths skipped this run because they exceed the size cap. */
  private skippedBig = new Set<string>();
  /** When we last actually walked the remote tree (ms); gates the fast path. */
  private lastRemoteWalkAt = 0;

  constructor(
    private app: App,
    private disk: YandexDisk,
    private settings: YasincSettings,
    private statePath: string,
    private cachePath: string,
    private installId: string
  ) {
    this.adapter = app.vault.adapter;
    this.remoteFolder = normalizeFolder(settings.remoteFolder);

    // Built-in ".obsidian/…" patterns must follow a custom config folder.
    const configDir =
      (this.app.vault as unknown as { configDir?: string }).configDir ||
      ".obsidian";
    const builtins = BUILT_IN_EXCLUDES.map((p) =>
      p === ".obsidian" || p.startsWith(".obsidian/")
        ? configDir + p.slice(".obsidian".length)
        : p
    );
    const patterns = [...settings.excludes, ...builtins];
    if (!settings.syncObsidian) patterns.push(configDir);
    this.excluder = new Excluder(patterns);

    this.limitBytes =
      settings.maxFileMb > 0 ? settings.maxFileMb * 1024 * 1024 : Infinity;

    this.snapshot = this.emptySnapshot();
  }

  /** Timestamp for conflict-copy names — computed per conflict (to the second),
   * never cached, so two conflicts on one path in a session can't collide. */
  private stampNow(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  // ---- public entry point -------------------------------------------------

  async run(opts: SyncOptions = {}): Promise<SyncStats> {
    const stats = emptyStats();
    this.skippedBig.clear();
    // Folders created earlier this session may have been removed on the Disk
    // since; don't trust the cache across runs.
    this.ensured.clear();
    await this.ensureLoaded();

    // Make sure the target folder exists so listing/uploading works.
    if (this.remoteFolder) {
      await this.disk.ensureFolder("/" + this.remoteFolder);
      this.markEnsured("/" + this.remoteFolder);
    }

    // Scan both sides at once — local walk is disk-bound, remote is network.
    opts.onProgress?.({ done: 0, total: 0, path: "local", phase: "scan" });
    const localPromise = this.walkLocal((n) =>
      opts.onProgress?.({ done: n, total: 0, path: "local", phase: "scan" })
    );
    const remotePromise = this.resolveRemote(opts);
    const [local, remote] = await Promise.all([localPromise, remotePromise]);

    // Safety brake: if a whole side is suddenly empty but we have a prior
    // snapshot and the other side isn't empty, that's almost certainly a scan
    // glitch — bailing out beats mass-deleting the user's files.
    const hadState = Object.keys(this.snapshot.entries).length > 0;
    if (hadState && local.size === 0 && remote.size > 0) {
      throw new Error(
        "локальное сканирование вернуло 0 файлов — отменяю, чтобы не удалить данные на Диске"
      );
    }
    if (hadState && remote.size === 0 && local.size > 0) {
      throw new Error(
        "папка на Диске пуста, хотя раньше была не пуста — отменяю, чтобы не удалить локальные файлы; если так и задумано, нажми «Сбросить состояние» в настройках"
      );
    }

    // Pre-hash pass: hash (in parallel) every local file we'll need to compare,
    // filling and incrementally saving the cache. This is the part that used to
    // take minutes on every open — now it happens once and survives interrupts.
    const needHash: LocalEntry[] = [];
    for (const L of local.values()) {
      if (remote.has(L.path) || this.snapshot.entries[L.path]) needHash.push(L);
    }
    let hashed = 0;
    await mapPool(needHash, HASH_CONCURRENCY, async (L) => {
      if (opts.signal?.aborted) return;
      // A file may vanish (deleted/renamed) between scan and hashing — skip it
      // rather than letting one ENOENT abort the whole sync. plan() will then
      // simply treat it as gone and reconcile accordingly.
      try {
        await this.localHash(L);
      } catch {
        return;
      }
      hashed++;
      if (hashed % 20 === 0) {
        opts.onProgress?.({
          done: hashed,
          total: needHash.length,
          path: L.path,
          phase: "hash",
        });
      }
    });
    await this.flushCache();

    const ops = await this.plan(local, remote);

    // LAST LINE OF DEFENCE: refuse to apply a suspicious mass deletion (e.g. a
    // snapshot copied from another device making every note look gone). Thrown
    // before anything is touched, so both sides stay intact until confirmed.
    this.assertNotBulkDelete(
      ops,
      Math.max(local.size, remote.size, Object.keys(this.snapshot.entries).length),
      opts
    );

    // Apply operations in parallel (network-bound), saving the snapshot
    // periodically so progress survives an interruption.
    let done = 0;
    await mapPool(ops, NET_CONCURRENCY, async (op) => {
      if (opts.signal?.aborted) return;
      // Report the file/action before doing it, so hover shows what's live now.
      opts.onProgress?.({
        done,
        total: ops.length,
        path: op.path,
        phase: "apply",
        op: op.type,
      });
      try {
        await this.apply(op, local.get(op.path), remote.get(op.path), stats);
      } catch (e) {
        stats.errors.push(`${op.type} ${op.path}: ${errMsg(e)}`);
      }
      done++;
      // On mobile, yield so the WebView can GC the file buffer (and the base64
      // copy Capacitor makes) before the next one — otherwise memory piles up
      // over a few dozen files and the app is killed.
      if (Platform.isMobile) await sleepMs(50);
      if (done % 25 === 0) void this.saveSnapshot();
    });

    // Remember the Disk revision so an unchanged Disk skips the walk next time.
    // Re-read it only if we actually wrote to the Disk (that bumps revision).
    let finalRev = this.currentDiskRevision;
    if (stats.uploaded + stats.deletedRemote + stats.conflicts > 0) {
      finalRev = await this.safeGetRevision();
    }
    if (finalRev !== null) this.snapshot.diskRevision = finalRev;

    // Surface size-capped files in the log so the cap is never silent.
    for (const p of this.skippedBig) {
      stats.skipped++;
      logLine(stats, `⏭ крупнее лимита: ${p}`);
    }

    // Prune hash-cache entries for files that no longer exist anywhere —
    // otherwise the cache grows forever, dragging every load/save.
    for (const p of Object.keys(this.persistentCache)) {
      if (!local.has(p) && !this.snapshot.entries[p]) {
        delete this.persistentCache[p];
      }
    }

    await this.saveSnapshot();
    await this.flushCache();
    return stats;
  }

  /** Load snapshot + hash cache once; kept in memory across syncs this session. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.snapshot = await this.loadSnapshot();
    this.persistentCache = await this.loadCache();
    this.loaded = true;
    // Keep a one-generation backup: if the main snapshot ever turns out
    // corrupt, loadSnapshot() falls back to this copy instead of a noisy
    // from-scratch union merge.
    if (Object.keys(this.snapshot.entries).length > 0) {
      try {
        await this.writeAtomic(
          this.statePath + ".bak",
          JSON.stringify(this.snapshot)
        );
      } catch (e) {
        console.warn("yasinc: не удалось записать sync-state.json.bak", e);
      }
    }
  }

  /**
   * Drop paths whose current content already matches the snapshot — i.e. not
   * really pending. Used to de-noise the dirty set after a sync: vault events
   * fired by our own downloads would otherwise inflate the ✎N counter.
   */
  async filterActuallyChanged(paths: string[]): Promise<string[]> {
    await this.ensureLoaded();
    const out: string[] = [];
    for (const path of paths) {
      if (this.excluder.test(path)) continue;
      const B = this.snapshot.entries[path];
      try {
        const st = await this.adapter.stat(path);
        if (st && st.type === "file") {
          const L: LocalEntry = { path, size: st.size, mtime: st.mtime };
          if (B && L.size === B.size && (await this.localHash(L)) === B.hash) {
            continue; // matches last sync — nothing pending
          }
          out.push(path);
        } else if (B) {
          out.push(path); // deleted locally, still on Disk
        }
      } catch {
        out.push(path); // can't tell — keep it pending, sync will sort it out
      }
    }
    return out;
  }

  /**
   * Fast in-session sync of only the paths that changed locally (fed from vault
   * events). Trusts that the Disk equals the snapshot — verified via the global
   * revision. If the Disk changed underneath us (edits from another device),
   * returns "need-full" so the caller falls back to a full run().
   *
   * Note: vault events don't cover changes inside .obsidian or edits made
   * outside Obsidian — those are caught by the periodic full sync.
   */
  async runIncremental(
    dirtyPaths: string[],
    opts: SyncOptions = {}
  ): Promise<SyncStats | "need-full"> {
    await this.ensureLoaded();

    // Only valid while the Disk hasn't changed since our last sync.
    const rev = await this.safeGetRevision();
    if (
      rev === null ||
      this.snapshot.diskRevision == null ||
      this.snapshot.diskRevision !== rev
    ) {
      return "need-full";
    }
    this.currentDiskRevision = rev;

    if (this.remoteFolder) {
      await this.disk.ensureFolder("/" + this.remoteFolder);
      this.markEnsured("/" + this.remoteFolder);
    }

    const stats = emptyStats();

    // Each dirty path -> an operation. Disk == snapshot, so no conflicts arise.
    const ops: Op[] = [];
    const seen = new Set<string>();
    for (const path of dirtyPaths) {
      if (seen.has(path) || this.excluder.test(path)) continue;
      seen.add(path);
      const st = await this.adapter.stat(path);
      const B = this.snapshot.entries[path];
      if (st && st.type === "file") {
        if (st.size > this.limitBytes) {
          stats.skipped++;
          logLine(stats, `⏭ крупнее лимита: ${path}`);
          continue;
        }
        const L: LocalEntry = { path, size: st.size, mtime: st.mtime };
        if (B && L.size === B.size && (await this.localHash(L)) === B.hash) {
          continue; // unchanged after all
        }
        // Overwriting an existing remote → guard against a concurrent change.
        ops.push(B ? { type: "upload", path, guard: B.hash } : { type: "upload", path });
      } else if (B) {
        ops.push({ type: "delRemote", path }); // gone locally, existed on Disk
      }
    }

    // Same guard on the incremental path (deletions here come from dirty paths
    // gone locally — still catastrophic if a foreign snapshot is in play).
    this.assertNotBulkDelete(
      ops,
      Object.keys(this.snapshot.entries).length,
      opts
    );

    let done = 0;
    for (const op of ops) {
      if (opts.signal?.aborted) {
        stats.errors.push("Синхронизация прервана");
        break;
      }
      opts.onProgress?.({
        done,
        total: ops.length,
        path: op.path,
        phase: "apply",
        op: op.type,
      });
      try {
        await this.apply(op, undefined, undefined, stats);
      } catch (e) {
        stats.errors.push(`${op.type} ${op.path}: ${errMsg(e)}`);
      }
      done++;
      if (Platform.isMobile) await sleepMs(50);
    }

    // Refresh the revision baseline after our own writes.
    let finalRev: number | null = this.currentDiskRevision;
    if (stats.uploaded + stats.deletedRemote > 0) {
      finalRev = await this.safeGetRevision();
    }
    if (finalRev !== null) this.snapshot.diskRevision = finalRev;

    await this.saveSnapshot();
    await this.flushCache();
    return stats;
  }

  // ---- planning -----------------------------------------------------------

  private async plan(
    local: Map<string, LocalEntry>,
    remote: Map<string, RemoteEntry>
  ): Promise<Op[]> {
    const ops: Op[] = [];
    const paths = new Set<string>([
      ...local.keys(),
      ...remote.keys(),
      ...Object.keys(this.snapshot.entries),
    ]);

    for (const path of Array.from(paths).sort()) {
      // A file hidden by the size cap must not be read as "deleted" — that
      // would delete the healthy copy on the other side.
      if (this.skippedBig.has(path)) continue;

      const L = local.get(path);
      const R = remote.get(path);
      const B = this.snapshot.entries[path];

      if (L && R) {
        // Both present. Identical? (cheap size gate before hashing)
        if (L.size === R.size && (await this.localHash(L)) === R.sha256) {
          // In sync — refresh snapshot mtime so quick-check keeps working.
          this.snapshot.entries[path] = {
            hash: R.sha256,
            size: R.size,
            mtime: L.mtime,
          };
          continue;
        }
        if (B) {
          const lEqB = await this.sameAsBase(L, B);
          const rEqB = R.sha256 === B.hash;
          if (lEqB && !rEqB) ops.push({ type: "download", path });
          else if (rEqB && !lEqB)
            ops.push({ type: "upload", path, guard: R.sha256 });
          else if (!lEqB && !rEqB) ops.push({ type: "conflict", path });
          // lEqB && rEqB is impossible here (would mean L===R).
        } else {
          ops.push({ type: "conflict", path });
        }
      } else if (L && !R) {
        if (B) {
          if (await this.sameAsBase(L, B)) ops.push({ type: "delLocal", path });
          else ops.push({ type: "upload", path }); // changed locally -> resurrect
        } else {
          ops.push({ type: "upload", path }); // new local file
        }
      } else if (!L && R) {
        if (B) {
          if (R.sha256 === B.hash) ops.push({ type: "delRemote", path });
          else ops.push({ type: "download", path }); // changed remotely -> resurrect
        } else {
          ops.push({ type: "download", path }); // new remote file
        }
      } else {
        // Only in snapshot — gone on both sides.
        delete this.snapshot.entries[path];
      }
    }
    return ops;
  }

  // ---- applying -----------------------------------------------------------

  private async apply(
    op: Op,
    L: LocalEntry | undefined,
    R: RemoteEntry | undefined,
    stats: SyncStats
  ): Promise<void> {
    switch (op.type) {
      case "upload":
        // Guard against clobbering a remote change made after we scanned:
        // if the Disk copy no longer matches what we planned against, this is
        // a real conflict, not a plain overwrite.
        if (op.guard !== undefined) {
          const meta = await this.disk.getMeta(this.absPath(op.path));
          // meta === null → remote gone (deleted elsewhere): safe to re-create.
          // meta present but hash differs OR is absent → the Disk copy is not
          // what we planned against (a just-uploaded file may have no sha256
          // yet — that's exactly the concurrent-write case), so keep both.
          if (meta && (meta.sha256 || "").toLowerCase() !== op.guard) {
            await this.doConflict(op.path);
            stats.conflicts++;
            logLine(stats, `⚠ конфликт (Диск изменён во время синхры): ${op.path}`);
            break;
          }
        }
        await this.doUpload(op.path, L);
        stats.uploaded++;
        logLine(stats, `↑ ${op.path}`);
        break;
      case "download":
        await this.doDownload(op.path, R);
        stats.downloaded++;
        logLine(stats, `↓ ${op.path}`);
        break;
      case "delLocal":
        await this.trashLocal(op.path);
        delete this.snapshot.entries[op.path];
        stats.deletedLocal++;
        logLine(stats, `🗑 локально: ${op.path}`);
        break;
      case "delRemote":
        await this.disk.remove(this.absPath(op.path));
        delete this.snapshot.entries[op.path];
        stats.deletedRemote++;
        logLine(stats, `🗑 на Диске: ${op.path}`);
        break;
      case "conflict":
        await this.doConflict(op.path);
        stats.conflicts++;
        logLine(stats, `⚠ конфликт: ${op.path}`);
        break;
    }
  }

  private async doUpload(path: string, L?: LocalEntry): Promise<void> {
    const data = await this.adapter.readBinary(path);
    const abs = this.absPath(path);
    await this.ensureRemoteDir(parentAbs(abs));
    await this.disk.upload(abs, data);
    const hash = await sha256Hex(data);
    const mtime = L ? L.mtime : await this.mtimeOf(path);
    this.recordHash(path, { mtime, size: data.byteLength, hash });
    this.snapshot.entries[path] = { hash, size: data.byteLength, mtime };
  }

  private async doDownload(path: string, R?: RemoteEntry): Promise<void> {
    const abs = this.absPath(path);
    const data = await this.disk.download(abs);
    const hash = await sha256Hex(data);
    // Verify integrity before touching the local file — a truncated download
    // must not overwrite good local data.
    if (R && R.sha256 && hash !== R.sha256) {
      throw new Error("контрольная сумма не совпала после скачивания");
    }
    await this.ensureLocalDir(path);
    await this.adapter.writeBinary(path, data);
    const mtime = await this.mtimeOf(path);
    this.recordHash(path, { mtime, size: data.byteLength, hash });
    this.snapshot.entries[path] = { hash, size: data.byteLength, mtime };
  }

  /**
   * Both sides changed the same file differently. Keep everything:
   *  - download the remote version to a sibling ".conflict-STAMP" file,
   *  - push that conflict copy to the Disk as well,
   *  - overwrite the remote original with our local version.
   * Nothing is lost; the user resolves the ".conflict-" file by hand.
   */
  private async doConflict(path: string): Promise<void> {
    const abs = this.absPath(path);
    const remoteData = await this.disk.download(abs);
    const localData = await this.adapter.readBinary(path);

    const conflictPath = this.conflictName(path);
    await this.ensureLocalDir(conflictPath);
    await this.adapter.writeBinary(conflictPath, remoteData);

    const absConf = this.absPath(conflictPath);
    await this.ensureRemoteDir(parentAbs(absConf));
    await this.disk.upload(absConf, remoteData);

    // Remote original becomes our local version.
    await this.disk.upload(abs, localData);

    const localHash = await sha256Hex(localData);
    const remoteHash = await sha256Hex(remoteData);
    const origMtime = await this.mtimeOf(path);
    const confMtime = await this.mtimeOf(conflictPath);
    this.recordHash(path, { mtime: origMtime, size: localData.byteLength, hash: localHash });
    this.recordHash(conflictPath, {
      mtime: confMtime,
      size: remoteData.byteLength,
      hash: remoteHash,
    });
    this.snapshot.entries[path] = {
      hash: localHash,
      size: localData.byteLength,
      mtime: origMtime,
    };
    this.snapshot.entries[conflictPath] = {
      hash: remoteHash,
      size: remoteData.byteLength,
      mtime: confMtime,
    };
  }

  // ---- local / remote enumeration ----------------------------------------

  private async walkLocal(
    onCount?: (n: number) => void
  ): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>();
    const stack: string[] = ["/"];
    while (stack.length) {
      const dir = stack.pop() as string;
      // A listing failure must abort the whole sync (thrown up to syncNow),
      // never be swallowed — otherwise missing files would look "deleted" and
      // we could wipe the other side.
      const listing = await this.adapter.list(normalizePath(dir));
      for (const f of listing.files) {
        if (this.excluder.test(f)) continue;
        const st = await this.adapter.stat(f);
        if (!st || st.type !== "file") continue;
        if (st.size > this.limitBytes) {
          this.skippedBig.add(f);
          continue;
        }
        out.set(f, { path: f, size: st.size, mtime: st.mtime });
        if (out.size % 50 === 0) onCount?.(out.size);
      }
      for (const d of listing.folders) {
        if (this.excluder.test(d)) continue;
        stack.push(d);
      }
    }
    return out;
  }

  private async walkRemote(
    onCount?: (n: number) => void
  ): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    // Walk only the target folder (in parallel), never the whole Disk — an
    // account full of unrelated files (phone photos, etc.) must not slow us.
    const rootAbs = this.remoteFolder ? "/" + this.remoteFolder : "/";
    const items = await this.disk.listTree(rootAbs, { concurrency: 8, onCount });
    const prefix = "disk:/" + (this.remoteFolder ? this.remoteFolder + "/" : "");
    for (const it of items) {
      if (!it.path.startsWith(prefix)) continue;
      const rel = it.path.slice(prefix.length);
      if (!rel || this.excluder.test(rel)) continue;
      if ((it.size ?? 0) > this.limitBytes) {
        this.skippedBig.add(rel);
        continue;
      }
      out.set(rel, {
        path: rel,
        size: it.size ?? 0,
        sha256: (it.sha256 || "").toLowerCase(),
        modified: it.modified ? Date.parse(it.modified) : 0,
      });
    }
    return out;
  }

  /**
   * Decide the remote side. If the Disk's global revision matches what we
   * recorded last sync, nothing changed on the Disk at all — reuse the
   * snapshot as the remote state and skip the whole folder walk entirely.
   */
  private async resolveRemote(
    opts: SyncOptions
  ): Promise<Map<string, RemoteEntry>> {
    this.currentDiskRevision = await this.safeGetRevision();
    const rev = this.currentDiskRevision;
    const haveSnapshot = Object.keys(this.snapshot.entries).length > 0;
    // The fast path is only sound when the revision matches AND we walked the
    // remote recently — a walk that happened while another device was mid-write
    // could have recorded a revision that already "hides" that write, so we
    // re-walk at least every RECONCILE_MS to let anything masked resurface.
    const fresh = Date.now() - this.lastRemoteWalkAt < RECONCILE_MS;
    if (
      !opts.forceRemoteWalk &&
      fresh &&
      rev !== null &&
      haveSnapshot &&
      this.snapshot.diskRevision === rev
    ) {
      opts.onProgress?.({ done: 0, total: 0, path: "remote-cached", phase: "scan" });
      return this.remoteFromSnapshot();
    }
    opts.onProgress?.({ done: 0, total: 0, path: "remote", phase: "scan" });
    const remote = await this.walkRemote((n) =>
      opts.onProgress?.({ done: n, total: 0, path: "remote", phase: "scan" })
    );
    this.lastRemoteWalkAt = Date.now();
    return remote;
  }

  /** Rebuild the remote picture from the snapshot (used on the fast path). */
  private remoteFromSnapshot(): Map<string, RemoteEntry> {
    const m = new Map<string, RemoteEntry>();
    for (const path of Object.keys(this.snapshot.entries)) {
      // Honour excludes here too: a path excluded since the snapshot was taken
      // must not look like "on the Disk but gone locally" → mass delRemote.
      if (this.excluder.test(path)) continue;
      const e = this.snapshot.entries[path];
      m.set(path, { path, size: e.size, sha256: e.hash, modified: 0 });
    }
    return m;
  }

  private async safeGetRevision(): Promise<number | null> {
    try {
      return await this.disk.getRevision();
    } catch {
      return null;
    }
  }

  /** Throw BulkDeleteError if the plan deletes a suspicious share of files. */
  private assertNotBulkDelete(
    ops: Op[],
    total: number,
    opts: SyncOptions
  ): void {
    if (opts.allowBulkDelete) return;
    const dels = ops.filter(
      (o) => o.type === "delLocal" || o.type === "delRemote"
    );
    if (
      dels.length > BULK_DELETE_MIN &&
      dels.length > Math.max(total, 1) * BULK_DELETE_FRACTION
    ) {
      throw new BulkDeleteError(
        dels.length,
        Math.max(total, dels.length),
        dels.slice(0, 20).map((o) => o.path)
      );
    }
  }

  // ---- hashing helpers ----------------------------------------------------

  private async localHash(L: LocalEntry): Promise<string> {
    // Quick check: unchanged since we last hashed it -> reuse recorded hash.
    const c = this.persistentCache[L.path];
    if (c && c.mtime === L.mtime && c.size === L.size) {
      return c.hash;
    }
    const data = await this.adapter.readBinary(L.path);
    const h = await sha256Hex(data);
    this.recordHash(L.path, { mtime: L.mtime, size: L.size, hash: h });
    return h;
  }

  private recordHash(path: string, entry: CacheEntry): void {
    this.persistentCache[path] = entry;
    this.cacheDirty++;
    if (this.cacheDirty >= 50 && !this.cacheSaving) void this.flushCache();
  }

  private async sameAsBase(
    L: LocalEntry,
    b: { hash: string; size: number }
  ): Promise<boolean> {
    if (L.size !== b.size) return false;
    return (await this.localHash(L)) === b.hash;
  }

  // ---- path & fs helpers --------------------------------------------------

  private absPath(rel: string): string {
    return "/" + [this.remoteFolder, rel].filter(Boolean).join("/");
  }

  private conflictName(path: string): string {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    return `${dir}${stem}.conflict-${this.stampNow()}${ext}`;
  }

  private async mtimeOf(path: string): Promise<number> {
    const st = await this.adapter.stat(path);
    return st ? st.mtime : Date.now();
  }

  private async ensureLocalDir(filePath: string): Promise<void> {
    const idx = filePath.lastIndexOf("/");
    if (idx < 0) return;
    const dir = filePath.slice(0, idx);
    if (!dir) return;
    const parts = dir.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      if (!(await this.adapter.exists(acc))) {
        await this.adapter.mkdir(acc);
      }
    }
  }

  private async ensureRemoteDir(absFolder: string): Promise<void> {
    if (!absFolder || absFolder === "/") return;
    if (this.ensured.has(absFolder)) return;
    await this.disk.ensureFolder(absFolder);
    this.markEnsured(absFolder);
  }

  private markEnsured(absFolder: string): void {
    let acc = absFolder;
    while (acc && acc !== "/") {
      this.ensured.add(acc);
      acc = parentAbs(acc);
    }
  }

  private async trashLocal(path: string): Promise<void> {
    try {
      const ok = await this.adapter.trashSystem(path);
      if (ok) return;
    } catch {
      /* fall through */
    }
    await this.adapter.trashLocal(path);
  }

  // ---- persistence --------------------------------------------------------

  private emptySnapshot(): Snapshot {
    return {
      version: SNAPSHOT_VERSION,
      remoteFolder: this.remoteFolder,
      syncedAt: 0,
      entries: {},
    };
  }

  /** Read and validate one snapshot file; null if missing/corrupt/mismatched. */
  private async readSnapshotFile(path: string): Promise<Snapshot | null> {
    try {
      if (!(await this.adapter.exists(path))) return null;
      const raw = await this.adapter.read(path);
      const snap = JSON.parse(raw) as Snapshot;
      // Reject a snapshot carried over from another device — trusting it would
      // read every absent-here file as a deletion and wipe both sides.
      if (snap.installId && snap.installId !== this.installId) {
        console.warn(
          "yasinc: снимок с другого устройства — игнорирую (будет чистая синхра, не удаление)"
        );
        return null;
      }
      if (
        snap.version === SNAPSHOT_VERSION &&
        snap.remoteFolder === this.remoteFolder &&
        snap.entries
      ) {
        return snap;
      }
    } catch (e) {
      console.warn(`yasinc: снимок ${path} повреждён или нечитаем`, e);
    }
    return null;
  }

  private async loadSnapshot(): Promise<Snapshot> {
    const main = await this.readSnapshotFile(this.statePath);
    if (main) return main;
    const bak = await this.readSnapshotFile(this.statePath + ".bak");
    if (bak) {
      console.warn("yasinc: основной снимок не читается — восстановлен из .bak");
      return bak;
    }
    return this.emptySnapshot();
  }

  /** Write via a temp file so a crash mid-write can't corrupt the JSON. */
  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = path + ".tmp";
    await this.adapter.write(tmp, data);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    await this.adapter.rename(tmp, path);
  }

  private async saveSnapshot(): Promise<void> {
    while (this.snapSaving) await sleepMs(20);
    this.snapSaving = true;
    try {
      this.snapshot.syncedAt = Date.now();
      this.snapshot.remoteFolder = this.remoteFolder;
      this.snapshot.installId = this.installId;
      await this.writeAtomic(this.statePath, JSON.stringify(this.snapshot));
    } catch (e) {
      console.warn("yasinc: не удалось сохранить sync-state.json", e);
    } finally {
      this.snapSaving = false;
    }
  }

  private async loadCache(): Promise<Record<string, CacheEntry>> {
    try {
      if (await this.adapter.exists(this.cachePath)) {
        const raw = await this.adapter.read(this.cachePath);
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") return obj as Record<string, CacheEntry>;
      }
    } catch {
      /* ignore — cache is just an optimization */
    }
    return {};
  }

  private async flushCache(): Promise<void> {
    while (this.cacheSaving) await sleepMs(20);
    this.cacheSaving = true;
    this.cacheDirty = 0;
    try {
      await this.writeAtomic(this.cachePath, JSON.stringify(this.persistentCache));
    } catch (e) {
      console.warn("yasinc: не удалось сохранить hash-cache.json", e);
    } finally {
      this.cacheSaving = false;
    }
  }
}

function parentAbs(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i <= 0 ? "/" : abs.slice(0, i);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Append to the sync log, capped so a giant first sync can't bloat memory. */
function logLine(stats: SyncStats, line: string): void {
  if (stats.log.length < 1000) stats.log.push(line);
  else if (stats.log.length === 1000) stats.log.push("… (остальное опущено)");
}
