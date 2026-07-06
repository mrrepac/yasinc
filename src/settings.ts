import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type YasincPlugin from "./main";
import { YandexDisk } from "./yandex";

const REGISTER_URL = "https://oauth.yandex.ru/client/new";
const APPS_LIST_URL = "https://oauth.yandex.ru/";
const REDIRECT_URI = "https://oauth.yandex.ru/verification_code";
const SCOPES = [
  "cloud_api:disk.read",
  "cloud_api:disk.write",
  "cloud_api:disk.info",
];

export interface YasincSettings {
  clientId: string;
  /** Master switch: when off, nothing syncs — no auto, no push, no manual. */
  syncEnabled: boolean;
  /** Target folder on the Disk (Disk-root relative, no leading slash). */
  remoteFolder: string;
  excludes: string[];
  syncObsidian: boolean;
  syncOnStartup: boolean;
  /** Auto-sync interval in minutes; 0 disables the timer. */
  autoSyncMinutes: number;
  /** Seconds of edit-quiet after which changed files are pushed; 0 = off. */
  autoPushSeconds: number;
  /** Files larger than this many MB are invisible to sync; 0 = no cap. */
  maxFileMb: number;
  lastSyncAt: number;
  lastSyncSummary: string;
}

/**
 * Always-on exclusions, baked into the engine and hidden from the user's
 * editable list. Dev junk, OS litter and device-local Obsidian state that is
 * never worth syncing (workspace/cursor files churn every few seconds and
 * would only breed conflict copies). The user's excludes field is purely for
 * their own patterns.
 */
export const BUILT_IN_EXCLUDES = [
  // yasinc's own per-device state must NEVER sync — a shared snapshot/cache
  // would make another device mis-sync, and data.json churns every run. But
  // main.js/manifest/styles DO sync, so the plugin reaches other devices.
  ".obsidian/plugins/yasinc/sync-state.json*",
  ".obsidian/plugins/yasinc/hash-cache.json*",
  ".obsidian/plugins/yasinc/data.json",
  ".git",
  "node_modules",
  ".trash",
  ".DS_Store",
  "Thumbs.db",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace.json.bak",
  ".obsidian/plugins/remember-cursor-position/cursor-positions*",
];

export const DEFAULT_SETTINGS: YasincSettings = {
  clientId: "",
  syncEnabled: true,
  remoteFolder: "",
  excludes: [],
  syncObsidian: true,
  syncOnStartup: true,
  autoSyncMinutes: 15,
  autoPushSeconds: 30,
  maxFileMb: 0,
  lastSyncAt: 0,
  lastSyncSummary: "",
};

/** Pull an OAuth token out of either a raw token or the full redirect URL. */
export function extractToken(input: string): string {
  const s = (input || "").trim();
  const m = s.match(/access_token=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return s;
}

export function formatWhen(ms: number): string {
  if (!ms) return "ещё не синхронизировалось";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

export class YasincSettingTab extends PluginSettingTab {
  /** Which onboarding branch is shown: create a new app or reuse an existing one. */
  private setupMode: "new" | "existing" = "new";
  /** Whether the step-by-step guide is expanded; decided on first render. */
  private setupOpen: boolean | null = null;

  constructor(app: App, private plugin: YasincPlugin) {
    super(app, plugin);
  }

  private async copy(text: string, okMsg: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(okMsg);
    } catch {
      new Notice("Не удалось скопировать. Вручную:\n" + text);
    }
  }

  /** Three separate copy buttons — Yandex's form wants scopes one at a time. */
  private addScopeButtons(st: Setting): void {
    for (const scope of SCOPES) {
      st.addButton((b) =>
        b
          .setButtonText(scope.replace("cloud_api:", ""))
          .setTooltip("Скопировать " + scope)
          .onClick(() =>
            this.copy(scope, `Скопировано: ${scope}\nВставь в поиск прав и выбери из подсказки.`)
          )
      );
    }
  }

  /** The step-by-step onboarding guide (re-rendered locally on branch switch). */
  private renderSetup(box: HTMLElement): void {
    box.empty();
    const s = this.plugin.settings;

    const mode = new Setting(box).setName("С чего начинаем?");
    mode.addButton((b) => {
      b.setButtonText("Приложения ещё нет");
      if (this.setupMode === "new") b.setCta();
      b.onClick(() => {
        this.setupMode = "new";
        this.renderSetup(box);
      });
    });
    mode.addButton((b) => {
      b.setButtonText("Приложение уже есть");
      if (this.setupMode === "existing") b.setCta();
      b.onClick(() => {
        this.setupMode = "existing";
        this.renderSetup(box);
      });
    });

    const step = (num: number, name: string, desc: string): Setting =>
      new Setting(box).setName(`Шаг ${num}. ${name}`).setDesc(desc);

    let n = 1;
    if (this.setupMode === "new") {
      step(
        n++,
        "Создай приложение Яндекса",
        "Войди в тот аккаунт, где твой Диск. На открывшейся странице выбери " +
          "«Для авторизации пользователей» → «Перейти к созданию»."
      ).addButton((b) =>
        b
          .setButtonText("Открыть oauth.yandex.ru")
          .setCta()
          .onClick(() => window.open(REGISTER_URL, "_blank"))
      );

      step(
        n++,
        "Название и иконка",
        "Название — любое (например, yasinc). Иконка обязательна — подойдёт любая картинка."
      );

      step(
        n++,
        "Платформа",
        "Отметь «Веб-сервисы» и вставь в поле Redirect URI адрес с кнопки."
      ).addButton((b) =>
        b
          .setButtonText("Скопировать Redirect URI")
          .onClick(() => this.copy(REDIRECT_URI, "Redirect URI скопирован."))
      );

      this.addScopeButtons(
        step(
          n++,
          "Права доступа — три штуки, по одной",
          "В блоке «Дополнительные» вставляй в поле «Название доступа» по одному " +
            "праву (кнопки ниже) и выбирай его из подсказки. Добавь все три."
        )
      );

      step(
        n++,
        "Создай и скопируй ClientID",
        "Жми «Создать приложение». Откроется карточка — скопируй из неё ClientID."
      );
    } else {
      step(
        n++,
        "Найди своё приложение",
        "Открой список своих приложений, выбери нужное и скопируй его ClientID."
      ).addButton((b) =>
        b
          .setButtonText("Открыть oauth.yandex.ru")
          .setCta()
          .onClick(() => window.open(APPS_LIST_URL, "_blank"))
      );

      const check = step(
        n++,
        "Проверь настройки приложения",
        "В карточке должны быть: платформа «Веб-сервисы» с Redirect URI (кнопка) " +
          "и три права Диска (кнопки). Чего-то нет — добавь и сохрани."
      );
      check.addButton((b) =>
        b
          .setButtonText("Redirect URI")
          .setTooltip("Скопировать " + REDIRECT_URI)
          .onClick(() => this.copy(REDIRECT_URI, "Redirect URI скопирован."))
      );
      this.addScopeButtons(check);
    }

    step(n++, "Вставь ClientID сюда", "Из карточки приложения.").addText((t) =>
      t
        .setPlaceholder("напр. 1a2b3c…")
        .setValue(s.clientId)
        .onChange(async (v) => {
          s.clientId = v.trim();
          await this.plugin.saveSettings();
        })
    );

    step(
      n++,
      "Авторизуйся",
      "На странице Яндекса нажми «Разрешить». Затем скопируй ВЕСЬ адрес из " +
        "адресной строки (в нём спрятан токен)."
    )
      .addButton((b) =>
        b
          .setButtonText("Открыть страницу авторизации")
          .setCta()
          .onClick(() => {
            if (!s.clientId) {
              new Notice("Сначала вставь ClientID (шаг выше).");
              return;
            }
            const url =
              "https://oauth.yandex.ru/authorize?response_type=token&client_id=" +
              encodeURIComponent(s.clientId);
            window.open(url, "_blank");
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("copy")
          .setTooltip("Скопировать ссылку авторизации")
          .onClick(() => {
            if (!s.clientId) {
              new Notice("Сначала вставь ClientID (шаг выше).");
              return;
            }
            const url =
              "https://oauth.yandex.ru/authorize?response_type=token&client_id=" +
              encodeURIComponent(s.clientId);
            void this.copy(url, "Ссылка скопирована.");
          })
      );

    const tokenStep = step(
      n++,
      "Вставь токен",
      "Скопированный адрес или сам токен — вытащу сам. Хранится только на этом устройстве."
    ).setClass("yasinc-setting-mono");
    tokenStep.addTextArea((t) =>
      t
        .setPlaceholder("access_token=… или y0_…")
        .setValue(this.plugin.getToken())
        .onChange(async (v) => {
          // Stored in app localStorage, not in data.json — so the token never
          // travels with vault backups or manual uploads.
          await this.plugin.setToken(extractToken(v));
        })
    );

    step(
      n,
      "Готово — проверь",
      "Нажми «Проверить подключение» вверху: должно показать свободное место."
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ---- Connection -------------------------------------------------------
    new Setting(containerEl).setName("Подключение к Яндекс.Диску").setHeading();

    // Live connection state + check button, always visible.
    const statusSetting = new Setting(containerEl).setName("Состояние");
    statusSetting.descEl.addClass("yasinc-token-status");
    const renderStatus = (text: string, ok?: boolean) => {
      statusSetting.setDesc(text);
      statusSetting.descEl.toggleClass("is-ok", ok === true);
      statusSetting.descEl.toggleClass("is-bad", ok === false);
    };
    const runCheck = async () => {
      if (!this.plugin.getToken()) {
        renderStatus("Не подключено — пройди шаги в инструкции ниже.", false);
        return;
      }
      renderStatus("Проверяю подключение…");
      try {
        const disk = new YandexDisk(this.plugin.getToken());
        const info = await disk.checkToken();
        const freeGb = ((info.totalSpace - info.usedSpace) / 1024 ** 3).toFixed(1);
        renderStatus(`✓ Подключено. Свободно на Диске: ${freeGb} ГБ.`, true);
      } catch (e) {
        renderStatus(
          "Не удалось: " + (e instanceof Error ? e.message : e),
          false
        );
      }
    };
    statusSetting.addButton((b) =>
      b.setButtonText("Проверить подключение").onClick(() => void runCheck())
    );
    void runCheck();

    // Collapsible onboarding guide — folded once a token is in place.
    if (this.setupOpen === null) this.setupOpen = !this.plugin.getToken();
    new Setting(containerEl)
      .setName("Инструкция по подключению")
      .setDesc(
        this.setupOpen
          ? "Пошаговый план. Свернётся, когда всё заработает."
          : "Понадобится при первом подключении, смене токена или устройства."
      )
      .addButton((b) =>
        b
          .setButtonText(this.setupOpen ? "Свернуть" : "Показать")
          .onClick(() => {
            this.setupOpen = !this.setupOpen;
            this.display();
          })
      );

    const setupBox = containerEl.createDiv({ cls: "yasinc-setup" });
    if (this.setupOpen) this.renderSetup(setupBox);

    // ---- Sync options -----------------------------------------------------
    new Setting(containerEl).setName("Синхронизация").setHeading();

    new Setting(containerEl)
      .setName("Синхронизация включена")
      .setDesc(
        "Общий выключатель. Когда выключено — плагин не трогает Диск вообще: " +
          "ни авто, ни фон, ни по кнопке."
      )
      .addToggle((t) =>
        t.setValue(s.syncEnabled).onChange(async (v) => {
          s.syncEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.applyAutoSyncTimer();
          this.plugin.refreshStatus();
        })
      );

    new Setting(containerEl)
      .setName("Папка на Диске")
      .setDesc("Куда складывать хранилище. Относительно корня Диска.")
      .addText((t) =>
        t
          .setPlaceholder("Obsidian/mrrepac")
          .setValue(s.remoteFolder)
          .onChange(async (v) => {
            s.remoteFolder = v.trim();
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
          })
      );

    new Setting(containerEl)
      .setName("Синхронизировать папку .obsidian")
      .setDesc("Настройки, темы и плагины тоже поедут между устройствами.")
      .addToggle((t) =>
        t.setValue(s.syncObsidian).onChange(async (v) => {
          s.syncObsidian = v;
          await this.plugin.saveSettings();
          this.plugin.resetEngine();
        })
      );

    new Setting(containerEl)
      .setName("Синхронизировать при запуске")
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Автосинхронизация")
      .setDesc("Как часто синхронизировать в фоне.")
      .addDropdown((d) =>
        d
          .addOptions({
            "0": "Выключена",
            "5": "Каждые 5 минут",
            "10": "Каждые 10 минут",
            "15": "Каждые 15 минут",
            "30": "Каждые 30 минут",
            "60": "Каждый час",
          })
          .setValue(String(s.autoSyncMinutes))
          .onChange(async (v) => {
            s.autoSyncMinutes = Number(v);
            await this.plugin.saveSettings();
            this.plugin.applyAutoSyncTimer();
          })
      );

    new Setting(containerEl)
      .setName("Автозаливка правок")
      .setDesc(
        "Пауза после последней правки, после которой изменённые файлы сами " +
          "улетают на Диск (инкрементально, без полного скана)."
      )
      .addDropdown((d) =>
        d
          .addOptions({
            "0": "Выключена",
            "10": "Через 10 секунд",
            "30": "Через 30 секунд",
            "60": "Через минуту",
            "120": "Через 2 минуты",
          })
          .setValue(String(s.autoPushSeconds))
          .onChange(async (v) => {
            s.autoPushSeconds = Number(v);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Лимит размера файла")
      .setDesc(
        "Файлы крупнее лимита не синхронизируются вовсе (ни туда, ни обратно) " +
          "и помечаются в журнале. Защита от случайного гигантского файла."
      )
      .addDropdown((d) =>
        d
          .addOptions({
            "0": "Без лимита",
            "50": "50 МБ",
            "100": "100 МБ",
            "200": "200 МБ",
            "500": "500 МБ",
          })
          .setValue(String(s.maxFileMb))
          .onChange(async (v) => {
            s.maxFileMb = Number(v);
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
          })
      );

    new Setting(containerEl)
      .setName("Исключения")
      .setDesc(
        "Свои шаблоны — по одному на строку. Имя без «/» исключает любую " +
          "папку/файл с таким именем; путь со «/» — от корня хранилища. " +
          "Встроенно исключены всегда (писать не нужно): .git, node_modules, " +
          ".trash, .DS_Store, Thumbs.db, workspace-файлы Obsidian, " +
          "cursor-positions и папка самого yasinc."
      )
      .setClass("yasinc-setting-mono")
      .addTextArea((t) =>
        t
          .setPlaceholder("например:\nАрхив/НРИ\n*.tmp")
          .setValue(s.excludes.join("\n"))
          .onChange(async (v) => {
            s.excludes = v
              .split("\n")
              .map((x) => x.trim())
              .filter((x) => x.length > 0);
            await this.plugin.saveSettings();
            this.plugin.resetEngine();
          })
      );

    // ---- Actions ----------------------------------------------------------
    new Setting(containerEl).setName("Действия").setHeading();

    new Setting(containerEl)
      .setName("Синхронизировать сейчас")
      .setDesc(
        "Последняя синхронизация: " +
          formatWhen(s.lastSyncAt) +
          (s.lastSyncSummary ? ` — ${s.lastSyncSummary}` : "")
      )
      .addButton((b) =>
        b
          .setButtonText("Синхронизировать")
          .setCta()
          .onClick(() => this.plugin.syncNow(true))
      )
      .addExtraButton((b) =>
        b
          .setIcon("list")
          .setTooltip("Журнал последней синхронизации")
          .onClick(() => this.plugin.openSyncLog())
      );

    new Setting(containerEl)
      .setName("Полная синхронизация")
      .setDesc(
        "Полный обход обеих сторон, включая .obsidian (плагины, темы, " +
          "настройки). Нужна, чтобы залить изменения плагинов — обычный " +
          "Ctrl+S их не видит (Obsidian не шлёт события для .obsidian)."
      )
      .addButton((b) =>
        b
          .setButtonText("Полная синхронизация")
          .onClick(() => this.plugin.syncNow(true, false))
      );

    new Setting(containerEl)
      .setName("Сбросить состояние синхры")
      .setDesc(
        "Забыть снимок прошлой синхры. Следующий запуск сольёт стороны " +
          "заново (ничего не удаляя). Нужно, если менял папку на Диске или " +
          "чистил её вручную."
      )
      .addButton((b) =>
        b
          .setButtonText("Сбросить")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSyncState();
          })
      );
  }
}
