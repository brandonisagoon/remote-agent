import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

/** Platform-native install root: Application Support on macOS, %APPDATA% on
    Windows, XDG-ish fallback elsewhere. */
export function defaultInstallRoot(serviceName: string): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      serviceName,
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", serviceName);
  }
  return path.join(os.homedir(), ".local", "share", serviceName);
}

/** The code tree this process runs from: the packaged app's resources when
    running as a built .app, otherwise the repository checkout. */
export function sourceRoot(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && existsSync(path.join(resourcesPath, "bin", "remote-agent"))) {
    return resourcesPath;
  }
  // Walk up to the tree root instead of hard-coding hops: this file sits at
  // management/paths.ts in the checkout but inside out/main/index.js in the
  // Electron bundle, so their depths differ. fileURLToPath form because
  // import.meta.dir is Bun-only and undefined in the Electron (Node) bundle.
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(directory, "remote-agent.config.example.json"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("remote-agent source root not found above " + fileURLToPath(import.meta.url));
    }
    directory = parent;
  }
}

export interface InstallLayout {
  root: string;
  /** Dedicated deployment clone; deploy fetches and resets it. */
  repo: string;
  /** The built copy the server runs from. */
  app: string;
  /** Logs, sqlite, snapshots. */
  state: string;
  backups: string;
  serviceLog: string;
  deployLog: string;
}

export function installLayout(installRoot: string): InstallLayout {
  const state = path.join(installRoot, "state");
  return {
    root: installRoot,
    repo: path.join(installRoot, "repo"),
    app: path.join(installRoot, "app"),
    state,
    backups: path.join(state, "backups"),
    serviceLog: path.join(state, "remote-agent.log"),
    deployLog: path.join(state, "deploy.log"),
  };
}

const POSIX_FALLBACK_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".bun", "bin"),
];

const WINDOWS_FALLBACK_DIRS = [
  path.join(os.homedir(), "scoop", "shims"),
  path.join(os.homedir(), ".bun", "bin"),
];

/** Locates an executable even from a Dock/Finder-launched GUI, whose PATH
    lacks the package-manager directories. */
export function findExecutable(name: string): string | null {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const fallbacks = process.platform === "win32" ? WINDOWS_FALLBACK_DIRS : POSIX_FALLBACK_DIRS;
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...fallbacks,
  ];
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
