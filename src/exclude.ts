/*
 * Path exclusion matcher.
 *
 * Two flavours of pattern:
 *  - no slash  -> matches any *segment* of a path ("node_modules", ".git",
 *    "*.tmp", "Thumbs.db"). Excludes the path if any segment matches.
 *  - has slash -> matches from the vault root ("Архив/НРИ", "/Шаблоны",
 *    ".obsidian/workspace.json"). Excludes the path itself and everything
 *    under it. Wildcards allowed. A leading slash also roots the pattern
 *    (gitignore habit): "/Шаблоны" excludes only the top-level one.
 *
 * Glob wildcards: `*` (not across "/"), `**` (across "/"), `?` (one non-"/").
 * Matching is case-insensitive — vaults live on case-insensitive filesystems
 * (Windows/macOS), so "Thumbs.db" must also catch "THUMBS.DB".
 */

/** Escape everything the regex engine treats specially, EXCEPT the glob
 * wildcards `*` and `?`, which we translate ourselves afterwards. */
function escapeLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRe(glob: string, subtree: boolean): RegExp {
  // Split on "**" so it becomes its own token — no placeholder char that could
  // collide with a literal (a space placeholder used to turn real spaces into
  // ".*" and over-match "Мои песни").
  const body = glob
    .split("**")
    .map((chunk) =>
      escapeLiteral(chunk).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    )
    .join(".*");
  // A rooted pattern that matches a folder must take its subtree with it —
  // otherwise the local walk prunes the folder while the remote flat file
  // list keeps its files, and the diff mass-deletes them on the other side.
  const tail = subtree ? "(/.*)?$" : "$";
  return new RegExp("^" + body + tail, "i");
}

export class Excluder {
  private nameRes: RegExp[] = [];
  private pathRes: RegExp[] = [];
  private pathPrefixes: string[] = [];

  constructor(patterns: string[]) {
    for (const raw of patterns) {
      // Normalize Windows-style separators; users paste both kinds.
      let p = (raw || "").trim().replace(/\\/g, "/");
      if (!p) continue;
      // Rootedness is decided BEFORE stripping the leading slash, so
      // "/Шаблоны" stays a root-only pattern instead of a segment one.
      const rooted = p.includes("/");
      p = p.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!p) continue;
      if (rooted) {
        if (/[*?]/.test(p)) this.pathRes.push(globToRe(p, true));
        else this.pathPrefixes.push(p.toLowerCase());
      } else {
        this.nameRes.push(globToRe(p, false));
      }
    }
  }

  /** True if this vault-relative path should be ignored by sync. */
  test(path: string): boolean {
    const lower = path.toLowerCase();
    const segs = lower.split("/");
    for (const re of this.nameRes) {
      for (const s of segs) if (re.test(s)) return true;
    }
    for (const pre of this.pathPrefixes) {
      if (lower === pre || lower.startsWith(pre + "/")) return true;
    }
    for (const re of this.pathRes) {
      if (re.test(lower)) return true;
    }
    return false;
  }
}
