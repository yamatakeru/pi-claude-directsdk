/** Private, inert native working directory with a stable path across Pi starts. */
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Native working directory must be a real directory: ${path}; remove the conflicting path`);
  }
  if (process.platform !== "win32") {
    if (stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw new Error(`Native working directory must be owned by the current user with mode 0700: ${path}; fix its ownership and permissions`);
    }
  }
}

export function stableChildCwd(): string {
  const setting = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_CACHE_HOME";
  const configured = process.platform === "darwin" ? undefined : process.env[setting];
  if (configured !== undefined && !isAbsolute(configured)) {
    throw new Error(`${setting} must be an absolute path; unset it to use the default cache directory`);
  }
  const base = configured ?? (process.platform === "win32"
    ? join(homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : join(homedir(), ".cache"));
  const root = join(base, "pi-claude-native");
  privateDirectory(root);
  const cwd = join(root, "child");
  privateDirectory(cwd);
  if (readdirSync(cwd).length !== 0) {
    throw new Error(`Native working directory must stay empty: ${cwd}; inspect and move its contents before retrying`);
  }
  return cwd;
}
