import fs from "node:fs/promises";
import path from "node:path";

/**
 * Credential files Claude Code and Codex read from the operator home.
 * Session history and the rest of those directories stay put.
 */
const AUTH_FILES = [
  [".codex", "auth.json"],
  [".claude", ".credentials.json"],
];

/**
 * Copy subscription auth into a disposable run HOME. The copy is a regular
 * file mode 0444, never a symlink, so a task cannot write the operator's
 * real credentials. A name the run already has is left alone. Missing
 * logins are ignored. Nothing is copied when the run HOME is the operator HOME.
 * @param {string} homeDir
 * @param {string | undefined} userHome
 * @returns {Promise<string[]>}
 */
export async function copyOperatorAuth(homeDir, userHome) {
  if (!userHome) return [];
  if (path.resolve(userHome) === path.resolve(homeDir)) return [];
  const copied = [];
  for (const [dir, file] of AUTH_FILES) {
    const relative = path.join(dir, file);
    const source = path.join(userHome, relative);
    const destDir = path.join(homeDir, dir);
    const dest = path.join(destDir, file);
    try {
      await fs.lstat(dest);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") continue;
    }
    let data;
    try {
      // stat follows a link so the bytes are copied. The destination is never a link.
      const stat = await fs.stat(source);
      if (!stat.isFile()) continue;
      data = await fs.readFile(source);
    } catch {
      continue;
    }
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(dest, data, { flag: "wx", mode: 0o444 });
    await fs.chmod(dest, 0o444);
    copied.push(relative);
  }
  return copied;
}
