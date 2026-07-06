# yasinc

Convenient two-way synchronization of an Obsidian vault with **Yandex Disk**
over its official REST API. Works on desktop and mobile (everything goes
through `requestUrl`, no third-party servers). Files are compared by
**sha256**, conflicts never overwrite your data, and deletions go to the trash.

> Documentation is also available in Russian: [README.ru.md](README.ru.md).

## What it does

- **Two-way sync** between the vault and a folder on Yandex Disk.
- **Three-way diff** (local ↔ last-sync snapshot ↔ Disk) — correctly tells
  "file deleted" apart from "file created on the other side", and never
  resurrects a deletion.
- **Manual and automatic**: ribbon button, command with a hotkey, sync on
  startup and on a timer.
- **Safety first**: when both sides changed a file, a `.conflict-…` copy is
  created (nothing is lost); deletions go to the Disk trash and the system
  trash; downloads are checksum-verified before they touch local files.

## Setup (once)

### 1. Register a Yandex application

1. Open <https://oauth.yandex.ru/client/new> (signed in to your Yandex account).
2. Give it any name (e.g. `yasinc`).
3. Platforms → enable **Web services**, set the Redirect URI to
   `https://oauth.yandex.ru/verification_code`.
4. Permissions → add Yandex Disk scopes:
   `cloud_api:disk.read`, `cloud_api:disk.write`, `cloud_api:disk.info`.
5. Create the app and copy its **ClientID**.

### 2. Get a token inside the plugin

1. Settings → yasinc → paste the **ClientID**.
2. Click **Open authorization page** → **Allow**.
3. You will be redirected to a URL like `…/verification_code#access_token=…`.
   Copy the whole URL (or just the token) into the **Access token** field —
   the plugin extracts the token itself.
4. Click **Check connection** — it should report your free space.

The token and the sync snapshot are stored only locally (in the plugin's
`data.json` and `sync-state.json`) and are **never uploaded to the Disk**.

## Settings

| Setting | Meaning |
|---|---|
| **Disk folder** | Where to store the vault (default `Obsidian/<vault name>`). |
| **Sync `.obsidian`** | Settings, themes and plugins travel between devices too. |
| **Sync on startup** | Auto-sync a few seconds after launch. |
| **Auto-sync** | Background full check on a timer (5–60 min, or off). |
| **Auto-push edits** | After N quiet seconds since the last edit, changed files are pushed automatically (incremental, no full scan). |
| **Exclusions** | What not to sync (one pattern per line). |
| **Reset sync state** | Forget the snapshot; the next run re-merges both sides without deleting anything. |

### Built-in exclusions

Always excluded and not shown in the list: `.git`, `node_modules`, `.trash`,
`.DS_Store`, `Thumbs.db`, Obsidian workspace files, `cursor-positions*`
(remember-cursor-position) and the yasinc plugin folder itself (sync snapshot
and cache). The "Exclusions" field is purely for your own patterns.

Pattern rules:
- **No `/`** — matches any folder/file with that name anywhere
  (`node_modules`, `.git`, `*.tmp`).
- **With `/`** — a path from the vault root (`.obsidian/workspace.json`).

## Conflict resolution

| Situation | What yasinc does |
|---|---|
| Changed locally only | Uploads to the Disk |
| Changed on the Disk only | Downloads |
| Changed on both sides | Keeps your local file and drops the remote one next to it as `name.conflict-YYYYMMDD-HHmm.ext`. Both versions end up on both sides |
| Deleted locally | Deletes on the Disk (to trash) |
| Deleted on the Disk | Deletes locally (to trash) |
| Deleted on one side, changed on the other | Restores it (edits win over deletion) |

**Safety brake:** if one side is suddenly empty during a sync (but wasn't
before), the sync aborts, so a transient read failure can't wipe the other
side.

## Usage

- The ⟳ ribbon icon — sync now.
- The **"yasinc: Sync now"** command (Ctrl+S by default). After the session's
  first full sync it goes incremental — only changed files fly, in a fraction
  of a second.
- The **"yasinc: Stop sync"** command — abort after the current file.
- The **"yasinc: Last sync log"** command — what exactly was uploaded,
  downloaded, deleted, and where conflicts arose.
- Click the status-bar indicator.
- The indicator shows a summary: `↑` uploaded, `↓` downloaded, `🗑` deleted,
  `⚠` conflicts, `✖` errors, `✎N` — pending local edits; hover during a sync
  to see the exact file being processed.

## Build

```bash
npm install
npm run build   # type-check + bundle main.js
npm run dev     # watch mode
```

## License

MIT © mrrepac
