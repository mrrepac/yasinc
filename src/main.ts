import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
} from "obsidian";
import {
  BUILT_IN_EXCLUDES,
  DEFAULT_SETTINGS,
  YasincSettings,
  YasincSettingTab,
  formatWhen,
} from "./settings";
import { YandexDisk } from "./yandex";
import { BulkDeleteError, SyncEngine, SyncProgress } from "./sync";
import { SyncStats } from "./types";

/** Force a full reconciling run at least this often, so local .obsidian edits
 * and remote changes masked during an earlier run can't hide indefinitely. */
const RECONCILE_MS = 10 * 60 * 1000;

export default class YasincPlugin extends Plugin {
  settings!: YasincSettings;
  private isSyncing = false;
  private ribbonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private autoTimer: number | null = null;
  /** Sync engine kept alive across syncs so its snapshot/cache stay in memory. */
  private engine: SyncEngine | null = null;
  /** Paths changed locally since the last sync (from vault events). */
  private dirty = new Set<string>();
  /** Whether a full sync has run this session (baseline for incremental). */
  private syncedThisSession = false;
  /** Debounce timer for auto-pushing edits after a quiet period. */
  private pushTimer: number | null = null;
  /** Cancellation flag for the currently running sync. */
  private abortSignal: { aborted: boolean } | null = null;
  /** Journal of the last sync, shown by the log modal. */
  private lastLog: string[] = [];
  private lastErrors: string[] = [];
  private lastSummary = "";
  /** Background-failure backoff: skip this many auto-sync ticks. */
  private failStreak = 0;
  private skipTicks = 0;
  /** Delayed startup-sync timer, cancelled if the plugin unloads first. */
  private startupTimer: number | null = null;
  /** OAuth token, kept in app localStorage — never inside the vault. */
  private tokenValue = "";
  /** Random per-device id (localStorage) stamped into the snapshot. */
  private installId = "";
  /** Live count of .conflict-… copies in the vault (drives the orange state). */
  private conflictCount = 0;
  /** Set once the layout is ready — before it, ignore the vault's startup
   * "create" storm so it doesn't flood the pending set. */
  private ready = false;
  /** Set in onunload; every timer callback and sync bails out on it. */
  private unloaded = false;
  /** When the last full (reconciling) run completed; gates incremental vs full. */
  private lastFullAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.installId = this.getOrCreateInstallId();

    this.ribbonEl = this.addRibbonIcon(
      "refresh-cw",
      "yasinc: синхронизировать с Яндекс.Диском",
      () => this.syncNow(true)
    );

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("yasinc-status");
    this.statusEl.onClickEvent(() => this.syncNow(true));
    this.lastSummary = this.settings.lastSyncSummary;
    this.updateIdleStatus();

    this.addCommand({
      id: "sync-now",
      name: "Синхронизировать сейчас",
      // Mod = Ctrl on Windows/Linux, Cmd on macOS. Obsidian saves files
      // automatically, so Ctrl+S is free — reuse it as "sync now".
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
      callback: () => this.syncNow(true),
    });

    this.addCommand({
      id: "full-sync",
      name: "Полная синхронизация (включая .obsidian)",
      // Incremental (Ctrl+S) only sees notes/attachments — Obsidian fires no
      // change events for files inside .obsidian. This forces a full walk so
      // plugin/theme/settings changes get pushed on demand.
      callback: () => this.syncNow(true, false),
    });

    this.addCommand({
      id: "stop-sync",
      name: "Остановить синхронизацию",
      callback: () => this.stopSync(),
    });

    this.addCommand({
      id: "show-log",
      name: "Журнал последней синхронизации",
      callback: () => this.openSyncLog(),
    });

    this.addCommand({
      id: "status",
      name: "Статус синхронизации",
      callback: () => this.showStatusNotice(),
    });

    this.addCommand({
      id: "sync-current-file",
      name: "Синхронизировать текущий файл",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("yasinc: нет активного файла.");
          return;
        }
        this.dirty.add(f.path);
        void this.syncNow(true);
      },
    });

    this.addCommand({
      id: "find-conflicts",
      name: "Найти конфликтные копии",
      callback: () => {
        const files = this.app.vault
          .getFiles()
          .filter((f) => CONFLICT_RE.test(f.name));
        if (!files.length) {
          new Notice("yasinc: конфликтных копий нет 🎉");
          return;
        }
        new ConflictFilesModal(this.app, files).open();
      },
    });

    this.addSettingTab(new YasincSettingTab(this.app, this));

    this.applyAutoSyncTimer();

    // Track local changes: manual (Ctrl+S) and auto-push syncs send just these.
    const onLocalChange = (path: string, extra?: string) => {
      // Ignore the vault's startup "create" storm and anything after unload.
      if (!this.ready || this.unloaded) return;
      this.dirty.add(path);
      if (extra) this.dirty.add(extra);
      // Creating/removing a conflict copy flips the orange state live.
      if (CONFLICT_RE.test(path) || (extra && CONFLICT_RE.test(extra))) {
        this.recountConflicts();
      }
      this.updateIdleStatus();
      this.schedulePush();
    };
    this.registerEvent(this.app.vault.on("modify", (f) => onLocalChange(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => onLocalChange(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => onLocalChange(f.path)));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => onLocalChange(f.path, oldPath))
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.ready = true;
      this.recountConflicts();
      this.updateIdleStatus();
      if (this.settings.syncOnStartup && this.settings.syncEnabled && this.getToken()) {
        // Small delay so startup isn't competing with vault indexing.
        this.startupTimer = window.setTimeout(() => {
          this.startupTimer = null;
          void this.syncNow(false);
        }, 3000);
      }
    });
  }

  onunload(): void {
    this.unloaded = true;
    if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
    if (this.pushTimer !== null) window.clearTimeout(this.pushTimer);
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    // Let a mid-flight sync wind down instead of hanging the reload.
    if (this.abortSignal) this.abortSignal.aborted = true;
  }

  // ---- settings -----------------------------------------------------------

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!Array.isArray(this.settings.excludes)) {
      this.settings.excludes = [...DEFAULT_SETTINGS.excludes];
    }
    // Token lives in app localStorage. Migrate it out of data.json (pre-0.3.0)
    // so it can never again leave the machine with a vault copy.
    this.tokenValue = this.loadTokenFromStorage();
    const legacyToken = (data as Record<string, unknown> | null)?.token;
    if (typeof legacyToken === "string" && legacyToken) {
      if (!this.tokenValue) await this.setToken(legacyToken);
      delete (this.settings as unknown as Record<string, unknown>).token;
      await this.saveSettings(); // rewrites data.json without the token
    }
    // Built-in exclusions are baked into the engine now — scrub them out of
    // the user's editable list (they used to live there as defaults).
    const scrubbed = this.settings.excludes.filter(
      (p) => !BUILT_IN_EXCLUDES.includes(p)
    );
    const legacyFlag = "noisyExcludesMigrated" in (this.settings as object);
    if (scrubbed.length !== this.settings.excludes.length || legacyFlag) {
      this.settings.excludes = scrubbed;
      delete (this.settings as unknown as Record<string, unknown>)
        .noisyExcludesMigrated;
      await this.saveSettings();
    }
    if (!this.settings.remoteFolder) {
      this.settings.remoteFolder = "Obsidian/" + this.app.vault.getName();
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- token (app localStorage, vault-scoped, never inside the vault) ------

  private static readonly TOKEN_KEY = "yasinc-token";

  getToken(): string {
    return this.tokenValue;
  }

  async setToken(token: string): Promise<void> {
    this.tokenValue = token;
    const anyApp = this.app as unknown as {
      saveLocalStorage?: (key: string, data: unknown | null) => void;
    };
    if (typeof anyApp.saveLocalStorage === "function") {
      anyApp.saveLocalStorage(YasincPlugin.TOKEN_KEY, token || null);
    } else {
      // Older Obsidian: raw localStorage, key namespaced by vault name.
      const key = YasincPlugin.TOKEN_KEY + "-" + this.app.vault.getName();
      if (token) window.localStorage.setItem(key, token);
      else window.localStorage.removeItem(key);
    }
    this.resetEngine();
  }

  private static readonly INSTALL_KEY = "yasinc-install-id";

  /** Stable random id for THIS device+vault, kept in app localStorage so it
   * never travels with the vault. Distinguishes a foreign copied snapshot. */
  private getOrCreateInstallId(): string {
    const anyApp = this.app as unknown as {
      loadLocalStorage?: (k: string) => unknown;
      saveLocalStorage?: (k: string, v: unknown | null) => void;
    };
    const key = YasincPlugin.INSTALL_KEY;
    const fallbackKey = key + "-" + this.app.vault.getName();
    let id: unknown =
      anyApp.loadLocalStorage?.(key) ??
      window.localStorage.getItem(fallbackKey);
    if (typeof id === "string" && id) return id;
    let fresh: string;
    try {
      fresh = crypto.randomUUID();
    } catch {
      fresh =
        "id-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2);
    }
    if (anyApp.saveLocalStorage) anyApp.saveLocalStorage(key, fresh);
    else window.localStorage.setItem(fallbackKey, fresh);
    return fresh;
  }

  private loadTokenFromStorage(): string {
    const anyApp = this.app as unknown as {
      loadLocalStorage?: (key: string) => unknown;
    };
    let v: unknown = null;
    if (typeof anyApp.loadLocalStorage === "function") {
      v = anyApp.loadLocalStorage(YasincPlugin.TOKEN_KEY);
    }
    if (v == null) {
      v = window.localStorage.getItem(
        YasincPlugin.TOKEN_KEY + "-" + this.app.vault.getName()
      );
    }
    return typeof v === "string" ? v : "";
  }

  // ---- sync ---------------------------------------------------------------

  applyAutoSyncTimer(): void {
    if (this.autoTimer !== null) {
      window.clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (this.settings.syncEnabled && minutes && minutes > 0) {
      this.autoTimer = window.setInterval(() => {
        // Back off after repeated background failures (offline, Yandex down)
        // instead of spamming a doomed request every tick.
        if (this.skipTicks > 0) {
          this.skipTicks--;
          return;
        }
        void this.syncNow(false);
      }, minutes * 60_000);
      this.registerInterval(this.autoTimer);
    }
  }

  /** Debounced push: after a quiet period since the last edit, sync just it. */
  private schedulePush(): void {
    const sec = this.settings.autoPushSeconds;
    // Needs a baseline, a token, an alive plugin — and not while backing off
    // from repeated failures (a push would just fail the same way).
    if (
      !sec ||
      !this.settings.syncEnabled ||
      !this.getToken() ||
      !this.syncedThisSession ||
      this.unloaded ||
      this.skipTicks > 0
    ) {
      return;
    }
    if (this.pushTimer !== null) window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      if (this.dirty.size > 0 && !this.isSyncing) void this.syncNow(false, true);
    }, sec * 1000);
  }

  private pluginDir(): string {
    return this.manifest.dir ?? ".obsidian/plugins/" + this.manifest.id;
  }

  private statePath(): string {
    return this.pluginDir() + "/sync-state.json";
  }

  private cachePath(): string {
    return this.pluginDir() + "/hash-cache.json";
  }

  /** Lazily build the sync engine and keep it alive across syncs this session. */
  private getEngine(): SyncEngine {
    if (!this.engine) {
      const disk = new YandexDisk(this.getToken());
      this.engine = new SyncEngine(
        this.app,
        disk,
        this.settings,
        this.statePath(),
        this.cachePath(),
        this.installId
      );
    }
    return this.engine;
  }

  /** Drop the cached engine — call when token/folder/excludes change. */
  resetEngine(): void {
    this.engine = null;
    this.syncedThisSession = false;
  }

  /** Forget the last-sync snapshot; the next run does a safe union merge. */
  async resetSyncState(): Promise<void> {
    if (this.isSyncing) {
      new Notice("yasinc: идёт синхронизация — останови её и повтори сброс.");
      return;
    }
    // Remove BOTH the snapshot and its .bak, or the engine would just restore
    // the old state from the backup and the reset would do nothing.
    for (const p of [this.statePath(), this.statePath() + ".bak"]) {
      if (await this.app.vault.adapter.exists(p)) {
        await this.app.vault.adapter.remove(p);
      }
    }
    this.resetEngine();
    new Notice("yasinc: состояние синхры сброшено.");
  }

  /** Ask the running sync to stop after the current file. */
  stopSync(): void {
    if (this.abortSignal && !this.abortSignal.aborted) {
      this.abortSignal.aborted = true;
      new Notice("yasinc: останавливаю после текущего файла…");
    } else {
      new Notice("yasinc: синхронизация сейчас не идёт.");
    }
  }

  openSyncLog(): void {
    new SyncLogModal(
      this.app,
      this.lastLog,
      this.lastErrors,
      this.settings.lastSyncAt
    ).open();
  }

  /** One notice with the full sync state — the mobile "status bar". */
  showStatusNotice(): void {
    const lines: string[] = [];
    if (this.isSyncing) lines.push("⏳ Сейчас синхронизируется…");
    lines.push(
      "Последняя синхра: " +
        formatWhen(this.settings.lastSyncAt) +
        (this.lastSummary ? ` — ${this.lastSummary}` : "")
    );
    if (this.dirty.size > 0)
      lines.push(`✎ Несинхронизированных правок: ${this.dirty.size}`);
    if (this.lastErrors.length) lines.push("✖ " + this.lastErrors[0]);
    new Notice("yasinc\n" + lines.join("\n"), 8000);
  }

  async syncNow(
    manual: boolean,
    preferIncremental = manual,
    allowBulkDelete = false
  ): Promise<void> {
    if (this.unloaded) return;
    if (this.isSyncing) {
      if (manual)
        new Notice(
          "yasinc: синхронизация уже идёт… (остановить — команда «Остановить синхронизацию»)"
        );
      return;
    }
    if (!this.settings.syncEnabled) {
      if (manual)
        new Notice("yasinc: синхронизация выключена в настройках.");
      return;
    }
    if (!this.getToken()) {
      if (manual)
        new Notice("yasinc: сначала подключи Яндекс.Диск в настройках.");
      return;
    }

    this.isSyncing = true;
    this.setSyncing(true);
    const signal = { aborted: false };
    this.abortSignal = signal;
    try {
      const engine = this.getEngine();
      const opts = {
        onProgress: (p: SyncProgress) => this.onProgress(p),
        signal,
        allowBulkDelete,
      };

      // Incremental (only locally-changed files) is used for manual/auto-push
      // once a baseline exists — but never if it's been too long since a full
      // run: a periodic full reconciliation catches .obsidian edits (no vault
      // events) and remote changes masked mid-run. Full runs force a real
      // remote walk.
      const stale = Date.now() - this.lastFullAt > RECONCILE_MS;
      const doIncremental =
        preferIncremental && this.syncedThisSession && !stale;

      let stats: SyncStats;
      let full = !doIncremental;
      if (doIncremental) {
        const result = await engine.runIncremental([...this.dirty], opts);
        if (result === "need-full") {
          full = true;
          stats = await engine.run({ ...opts, forceRemoteWalk: true });
        } else {
          stats = result;
        }
      } else {
        stats = await engine.run({ ...opts, forceRemoteWalk: true });
      }

      if (signal.aborted) {
        // Incomplete — don't claim a baseline, keep pending edits, force a
        // full reconcile next time.
        this.syncedThisSession = false;
        this.lastErrors = ["синхронизация прервана"];
        this.lastSummary = "прервано";
        if (manual) new Notice("yasinc: синхронизация прервана.");
      } else {
        if (full) {
          this.syncedThisSession = true;
          this.lastFullAt = Date.now();
        }
        const summary = summarize(stats);
        this.settings.lastSyncAt = Date.now();
        this.settings.lastSyncSummary = summary;
        await this.saveSettings();
        this.lastLog = stats.log;
        this.lastErrors = stats.errors;
        this.lastSummary = summary;

        // Per-op failures inside an otherwise-"successful" run still count as
        // trouble for the background backoff; a truly clean run resets it.
        if (!manual && stats.errors.length) {
          this.failStreak++;
          this.skipTicks = Math.min(this.failStreak, 6);
        } else {
          this.failStreak = 0;
          this.skipTicks = 0;
        }

        // Notices: manual syncs always report; background ones only on
        // conflicts (or, on mobile, when files actually moved).
        if (manual) {
          new Notice(
            "yasinc: " +
              summary +
              (stats.errors.length
                ? "\n" + stats.errors.slice(0, 5).join("\n")
                : "")
          );
        } else if (stats.conflicts > 0) {
          new Notice(
            `yasinc: ⚠ конфликтов: ${stats.conflicts} — подробности в журнале синхронизации`
          );
        } else if (Platform.isMobile && hasRealChanges(stats)) {
          new Notice("yasinc: " + summary, 4000);
        }
      }
    } catch (e) {
      if (e instanceof BulkDeleteError) {
        // Nothing was touched. Always surface this loudly (even in background)
        // — it's the one thing the user must see. No backoff: it's a guard,
        // not a failure.
        this.lastErrors = [`⚠ остановлено удаление ${e.count} файлов`];
        this.lastSummary = "⚠ остановлено";
        new BulkDeleteConfirmModal(this.app, this, e).open();
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.lastErrors = [msg];
      this.lastSummary = "ошибка";
      if (manual) {
        new Notice("yasinc: ошибка синхронизации — " + msg);
      } else {
        // Quiet background failure: red status + growing backoff.
        this.failStreak++;
        this.skipTicks = Math.min(this.failStreak, 6);
      }
    } finally {
      this.abortSignal = null;
      // Prune the pending set WHILE still marked syncing, so a timer can't slip
      // a second sync into the gap. Drop only paths we examined and found
      // already in sync (matching the snapshot); failed/aborted ones and edits
      // that arrived mid-sync stay pending. Per-path delete (not set-replace)
      // preserves anything added during the await.
      if (this.dirty.size > 0 && this.engine && !this.unloaded) {
        try {
          const examined = [...this.dirty];
          const pending = new Set(
            await this.engine.filterActuallyChanged(examined)
          );
          for (const p of examined) if (!pending.has(p)) this.dirty.delete(p);
        } catch {
          /* keep dirty as-is — better to over-report than to lose edits */
        }
      }
      this.isSyncing = false;
      this.setSyncing(false);
      this.recountConflicts();
      this.updateIdleStatus();
      if (!this.unloaded && this.dirty.size > 0) this.schedulePush();
    }
  }

  // ---- status UI ----------------------------------------------------------

  /** Public wrapper so the settings tab can refresh the indicator on toggle. */
  refreshStatus(): void {
    this.recountConflicts();
    this.updateIdleStatus();
  }

  private recountConflicts(): void {
    this.conflictCount = this.app.vault
      .getFiles()
      .filter((f) => CONFLICT_RE.test(f.name)).length;
  }

  /**
   * Traffic-light idle indicator:
   *   green dot — fully synced; yellow dot + N — pending local edits;
   *   orange ⚠N — conflict copies sitting in the vault; red dot — last sync
   *   failed; gray dot — not connected. Details live in the hover tooltip.
   */
  private updateIdleStatus(): void {
    if (this.isSyncing) return;
    if (!this.settings.syncEnabled) {
      this.renderStatus("gray", "⏸", "синхронизация выключена в настройках");
      return;
    }
    const when = this.settings.lastSyncAt
      ? "последняя синхра: " + formatWhen(this.settings.lastSyncAt)
      : "ещё не синхронизировалось";
    if (!this.getToken()) {
      this.renderStatus("gray", "", "не подключено — открой настройки yasinc");
      return;
    }
    if (this.lastErrors.length) {
      this.renderStatus(
        "red",
        "",
        `ошибка: ${this.lastErrors[0]} • ${when}`
      );
      return;
    }
    if (this.conflictCount > 0) {
      this.renderStatus(
        "orange",
        `⚠${this.conflictCount}`,
        `конфликтных копий в хранилище: ${this.conflictCount} — команда «Найти конфликтные копии»`
      );
      return;
    }
    if (this.dirty.size > 0) {
      this.renderStatus(
        "yellow",
        String(this.dirty.size),
        `несинхронизированных правок: ${this.dirty.size} • ${when}`
      );
      return;
    }
    this.renderStatus("green", "", `всё синхронизировано • ${when}`);
  }

  private onProgress(p: SyncProgress): void {
    if (p.phase === "scan") {
      if (p.path === "remote-cached")
        this.renderStatus("busy", "", "Диск не менялся с прошлой синхры, сверяю");
      else if (p.path === "remote")
        this.renderStatus(
          "busy",
          p.done > 0 ? String(p.done) : "",
          "Читаю список файлов на Яндекс.Диске"
        );
      else
        this.renderStatus(
          "busy",
          p.done > 0 ? String(p.done) : "",
          "Сканирую локальное хранилище"
        );
    } else if (p.phase === "hash") {
      this.renderStatus(
        "busy",
        `${p.done}/${p.total}`,
        p.path ? "Хэширую: " + p.path : "Хэширую файлы"
      );
    } else if (p.phase === "apply" && p.total > 0 && p.path) {
      this.renderStatus(
        "busy",
        `${opSymbol(p.op)} ${p.done}/${p.total}`,
        `${opLabel(p.op)}: ${p.path}`
      );
    }
  }

  private setSyncing(on: boolean): void {
    this.ribbonEl?.toggleClass("yasinc-spin", on);
  }

  /** Render the status-bar cell: a colored dot (or spinner) + optional text. */
  private renderStatus(
    state: "green" | "yellow" | "orange" | "red" | "gray" | "busy",
    text: string,
    tip: string
  ): void {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    if (state === "busy") {
      el.createSpan({ cls: "yasinc-busy", text: "⟳" });
    } else {
      el.createSpan({ cls: "yasinc-dot is-" + state });
    }
    if (text) el.createSpan({ text });
    // aria-label only: Obsidian renders its own tooltip from it; a `title`
    // attribute would add a second (native) tooltip on top.
    el.setAttr("aria-label", "yasinc: " + tip);
    el.removeAttribute("title");
  }
}

/** Matches the sibling copies the sync engine creates on conflicts. */
const CONFLICT_RE = /\.conflict-\d{8}-\d{4}/;

// ---- conflict files modal ---------------------------------------------------

class ConflictFilesModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[]) {
    super(app);
    this.setPlaceholder(`Конфликтные копии (${files.length}) — выбери, чтобы открыть`);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    void this.app.workspace.getLeaf().openFile(f);
  }
}

// ---- bulk-delete confirmation ----------------------------------------------

class BulkDeleteConfirmModal extends Modal {
  constructor(
    app: App,
    private plugin: YasincPlugin,
    private err: BulkDeleteError
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("⚠️ yasinc остановил массовое удаление");
    const c = this.contentEl;
    c.createEl("p", {
      text:
        `Синхронизация собиралась удалить ${this.err.count} файлов ` +
        `(из ~${this.err.total}). НИЧЕГО не удалено — это защита.`,
    });
    c.createEl("p", {
      cls: "yasinc-hint",
      text:
        "Чаще всего причина — это НОВОЕ устройство, куда скопировали снимок " +
        "синхры (sync-state.json) с другого компа. Тогда жми «Сбросить " +
        "состояние»: файлы СКАЧАЮТСЯ, а не удалятся. Удаляй только если ты " +
        "правда стёр эти файлы и хочешь убрать их со всех устройств.",
    });
    const list = c.createEl("div", { cls: "yasinc-log" });
    for (const p of this.err.samples) list.createEl("div", { text: "🗑 " + p });
    if (this.err.count > this.err.samples.length) {
      list.createEl("div", {
        text: `… и ещё ${this.err.count - this.err.samples.length}`,
      });
    }

    const btns = c.createDiv({ cls: "modal-button-container" });
    const reset = btns.createEl("button", {
      text: "Сбросить состояние и скачать заново",
      cls: "mod-cta",
    });
    reset.onclick = async () => {
      this.close();
      await this.plugin.resetSyncState();
      void this.plugin.syncNow(true, false);
    };
    const del = btns.createEl("button", {
      text: `Всё равно удалить ${this.err.count}`,
      cls: "mod-warning",
    });
    del.onclick = () => {
      this.close();
      void this.plugin.syncNow(true, false, true);
    };
    const cancel = btns.createEl("button", { text: "Отмена" });
    cancel.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---- sync log modal --------------------------------------------------------

class SyncLogModal extends Modal {
  constructor(
    app: App,
    private log: string[],
    private errors: string[],
    private when: number
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("yasinc — журнал последней синхронизации");
    const c = this.contentEl;
    c.createEl("p", { text: formatWhen(this.when), cls: "yasinc-hint" });
    if (this.errors.length) {
      const box = c.createEl("div", { cls: "yasinc-log-errors" });
      box.createEl("div", { text: `Ошибки (${this.errors.length}):` });
      for (const e of this.errors) box.createEl("div", { text: "✖ " + e });
    }
    if (!this.log.length && !this.errors.length) {
      c.createEl("p", { text: "Изменений не было — всё актуально." });
      return;
    }
    if (this.log.length) {
      const box = c.createEl("div", { cls: "yasinc-log" });
      for (const line of this.log) box.createEl("div", { text: line });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---- helpers --------------------------------------------------------------

function opSymbol(op?: string): string {
  switch (op) {
    case "upload":
      return "↑";
    case "download":
      return "↓";
    case "delLocal":
    case "delRemote":
      return "🗑";
    case "conflict":
      return "⚠";
    default:
      return "•";
  }
}

function opLabel(op?: string): string {
  switch (op) {
    case "upload":
      return "Загружаю на Диск";
    case "download":
      return "Скачиваю с Диска";
    case "delLocal":
      return "Удаляю локально";
    case "delRemote":
      return "Удаляю на Диске";
    case "conflict":
      return "Конфликт — сохраняю обе версии";
    default:
      return "Обрабатываю";
  }
}

function hasRealChanges(s: SyncStats): boolean {
  return (
    s.uploaded + s.downloaded + s.deletedLocal + s.deletedRemote + s.conflicts >
    0
  );
}

function summarize(s: SyncStats): string {
  const parts: string[] = [`↑${s.uploaded}`, `↓${s.downloaded}`];
  if (s.deletedLocal + s.deletedRemote > 0) {
    parts.push(`🗑${s.deletedLocal + s.deletedRemote}`);
  }
  if (s.conflicts > 0) parts.push(`⚠${s.conflicts}`);
  if (s.errors.length > 0) parts.push(`✖${s.errors.length}`);
  if (s.uploaded + s.downloaded + s.deletedLocal + s.deletedRemote + s.conflicts === 0 && s.errors.length === 0) {
    return "актуально";
  }
  return parts.join(" ");
}
