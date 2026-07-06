/*
 * Minimal Yandex Disk REST API client.
 * Docs: https://yandex.ru/dev/disk/api/reference/
 * Everything goes through Obsidian's requestUrl so it works on mobile too
 * (no CORS, no Node http).
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const API = "https://cloud-api.yandex.net/v1/disk";

/** Fields we ask the API to return for each resource. */
const ITEM_FIELDS = ["name", "path", "type", "size", "sha256", "modified"];

export interface YdItem {
  name: string;
  path: string; // "disk:/..."
  type: "file" | "dir";
  size?: number;
  sha256?: string;
  modified?: string; // ISO 8601
}

export class YandexError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "YandexError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** requestUrl has no timeout of its own — one stuck connection would hang the
 * sync forever (isSyncing stays true until app restart). Cap every request. */
const API_TIMEOUT = 45_000;
/** Uploads/downloads of big audio need far more slack than JSON calls. */
const TRANSFER_TIMEOUT = 600_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Human-readable causes for the statuses users actually hit. */
const KNOWN_HTTP: Record<number, string> = {
  401: "токен недействителен или отозван — получи новый в настройках yasinc",
  403: "нет прав — проверь доступы приложения (cloud_api:disk.*)",
  423: "Диск временно доступен только для чтения (работы у Яндекса)",
  507: "на Яндекс.Диске закончилось место",
};

/** Build "disk:/a/b/c" from a leading-slash absolute Disk path. */
function toDiskPath(absPath: string): string {
  const clean = absPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return "disk:/" + clean;
}

export interface ListTreeOptions {
  concurrency?: number;
  onCount?: (filesSoFar: number) => void;
}

export class YandexDisk {
  constructor(private token: string) {}

  setToken(token: string): void {
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `OAuth ${this.token}`,
      Accept: "application/json",
    };
  }

  /** requestUrl with a hard timeout and retry on 429 / 5xx / network errors. */
  private async send(
    params: RequestUrlParam,
    retries = 3,
    timeoutMs = API_TIMEOUT
  ): Promise<RequestUrlResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await withTimeout(
          requestUrl({ ...params, throw: false }),
          timeoutMs,
          "сеть"
        );
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < retries) {
            await sleep(500 * Math.pow(2, attempt));
            continue;
          }
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Call the JSON API; throws YandexError on non-2xx. */
  private async api(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<any> {
    let url = API + path;
    if (query) {
      const qs = Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      if (qs) url += "?" + qs;
    }
    const res = await this.send({ url, method, headers: this.authHeaders() });
    if (res.status < 200 || res.status >= 300) {
      throw new YandexError(res.status, this.errMessage(res));
    }
    try {
      return res.json;
    } catch {
      return null;
    }
  }

  private errMessage(res: { status: number; json?: any; text?: string }): string {
    const known = KNOWN_HTTP[res.status];
    if (known) return `${known} (HTTP ${res.status})`;
    try {
      const j = res.json;
      if (j && (j.message || j.description)) {
        return `${j.message || j.description} (HTTP ${res.status})`;
      }
    } catch {
      /* ignore */
    }
    return `HTTP ${res.status}`;
  }

  /** Verify the token & connectivity. Returns the account's Disk info. */
  async checkToken(): Promise<{ totalSpace: number; usedSpace: number }> {
    const info = await this.api("GET", "");
    return {
      totalSpace: info?.total_space ?? 0,
      usedSpace: info?.used_space ?? 0,
    };
  }

  /**
   * Global Disk revision — a counter that increases on any change anywhere on
   * the Disk. Same value on two reads ⇒ nothing changed in between.
   * Returns null if the field is unavailable.
   */
  async getRevision(): Promise<number | null> {
    const info = await this.api("GET", "");
    return typeof info?.revision === "number" ? info.revision : null;
  }

  /** Create a folder and all missing parents. Existing folders are fine. */
  async ensureFolder(absPath: string): Promise<void> {
    const clean = absPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) return;
    const parts = clean.split("/");
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      const res = await this.send({
        url: API + "/resources?path=" + encodeURIComponent(toDiskPath(acc)),
        method: "PUT",
        headers: this.authHeaders(),
      });
      if (res.status === 201 || res.status === 409) continue;
      if (res.status < 200 || res.status >= 300) {
        throw new YandexError(res.status, this.errMessage(res));
      }
    }
  }

  /** Metadata for a single resource, or null if it does not exist (404). */
  async getMeta(absPath: string): Promise<YdItem | null> {
    let url = API + "/resources?path=" + encodeURIComponent(toDiskPath(absPath));
    url += "&fields=" + encodeURIComponent(ITEM_FIELDS.join(","));
    const res = await this.send({ url, method: "GET", headers: this.authHeaders() });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new YandexError(res.status, this.errMessage(res));
    }
    return res.json as YdItem;
  }

  /** List the immediate children of one folder, paginating as needed. */
  private async listFolderChildren(
    dirDisk: string
  ): Promise<{ items: YdItem[]; missing: boolean }> {
    const items: YdItem[] = [];
    const limit = 200;
    let offset = 0;
    const fields = [
      "_embedded.total",
      "_embedded.items.name",
      "_embedded.items.path",
      "_embedded.items.type",
      "_embedded.items.size",
      "_embedded.items.sha256",
      "_embedded.items.modified",
    ].join(",");
    for (;;) {
      const url =
        API +
        "/resources?path=" +
        encodeURIComponent(dirDisk) +
        "&limit=" +
        limit +
        "&offset=" +
        offset +
        "&fields=" +
        encodeURIComponent(fields);
      const res = await this.send({ url, method: "GET", headers: this.authHeaders() });
      if (res.status === 404) return { items, missing: true };
      if (res.status < 200 || res.status >= 300) {
        throw new YandexError(res.status, this.errMessage(res));
      }
      const emb = res.json?._embedded;
      const its: YdItem[] = emb?.items ?? [];
      for (const it of its) items.push(it);
      const total: number = emb?.total ?? its.length;
      offset += its.length;
      if (its.length === 0 || offset >= total) break;
    }
    return { items, missing: false };
  }

  /**
   * List every file under `rootAbsPath`, walking folders in parallel.
   * Only the target folder is traversed (not the whole Disk), so an account
   * stuffed with unrelated files — phone photo uploads, etc. — doesn't slow
   * this down. Returns a flat array of file items; empty if the root is absent.
   */
  async listTree(rootAbsPath: string, opts: ListTreeOptions = {}): Promise<YdItem[]> {
    const concurrency = opts.concurrency ?? 8;
    const out: YdItem[] = [];
    const rootDisk = toDiskPath(rootAbsPath);
    const queue: string[] = [rootDisk];
    let active = 0;
    let rootMissing = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        if (err) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (queue.length === 0 && active === 0) {
          settled = true;
          resolve();
        }
      };
      const pump = () => {
        if (settled) return;
        while (active < concurrency && queue.length > 0) {
          const dir = queue.shift() as string;
          active++;
          this.listFolderChildren(dir)
            .then(({ items, missing }) => {
              // Another worker may have already failed the whole walk; don't
              // keep mutating results / firing progress after we've settled.
              if (settled) return;
              if (missing) {
                if (dir === rootDisk) rootMissing = true;
                return;
              }
              for (const it of items) {
                if (it.type === "dir") queue.push(it.path);
                else if (it.type === "file") out.push(it);
              }
              opts.onCount?.(out.length);
            })
            .then(() => {
              active--;
              pump();
              finish();
            })
            .catch((e) => {
              active--;
              finish(e);
            });
        }
        finish();
      };
      pump();
    });

    if (rootMissing && out.length === 0) return [];
    return out;
  }

  /** Upload binary data to `absPath`, overwriting if present. */
  async upload(absPath: string, data: ArrayBuffer): Promise<void> {
    const link = await this.api("GET", "/resources/upload", {
      path: toDiskPath(absPath),
      overwrite: true,
    });
    const href: string = link?.href;
    const method: string = (link?.method || "PUT").toUpperCase();
    if (!href) throw new YandexError(0, "upload: no href returned");
    // One retry only: with the generous transfer timeout, more would stall
    // the whole sync for too long on a genuinely dead link.
    const res = await this.send(
      {
        url: href,
        method,
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
      },
      1,
      TRANSFER_TIMEOUT
    );
    if (res.status < 200 || res.status >= 300) {
      throw new YandexError(res.status, this.errMessage(res));
    }
  }

  /** Download binary data from `absPath`. */
  async download(absPath: string): Promise<ArrayBuffer> {
    const link = await this.api("GET", "/resources/download", {
      path: toDiskPath(absPath),
    });
    const href: string = link?.href;
    const method: string = (link?.method || "GET").toUpperCase();
    if (!href) throw new YandexError(0, "download: no href returned");
    const res = await this.send({ url: href, method }, 1, TRANSFER_TIMEOUT);
    if (res.status < 200 || res.status >= 300) {
      throw new YandexError(res.status, this.errMessage(res));
    }
    return res.arrayBuffer;
  }

  /** Delete a resource, sending it to the Disk trash by default. */
  async remove(absPath: string, permanently = false): Promise<void> {
    const res = await this.send({
      url:
        API +
        "/resources?path=" +
        encodeURIComponent(toDiskPath(absPath)) +
        "&permanently=" +
        (permanently ? "true" : "false"),
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (res.status === 204 || res.status === 202 || res.status === 404) return;
    if (res.status < 200 || res.status >= 300) {
      throw new YandexError(res.status, this.errMessage(res));
    }
  }
}
