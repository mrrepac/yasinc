/*
 * SHA-256 over binary data using the Web Crypto API.
 * crypto.subtle is available both in the Obsidian desktop (Electron) and on
 * mobile (Capacitor WebView), so this is our one cross-platform hashing path.
 */

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
