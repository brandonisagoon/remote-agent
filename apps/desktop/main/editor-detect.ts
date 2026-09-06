import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app, nativeImage } from "electron";

const run = promisify(execFile);

export interface DetectedEditor {
  name: string;
  /** Deep-link scheme; null for apps opened via `open -a`. */
  scheme: string | null;
  /** "scheme" = URL deep link (SSH capable); "app" = open the folder with
      the app directly (local only). */
  open: "scheme" | "app";
  appPath: string;
  /** PNG data URL of the app's icon. */
  icon: string | null;
}

/** Editor apps worth probing for, AI-native ones included. The scheme is a
    fallback — the app's own Info.plist URL scheme wins when present. */
const CANDIDATES: Array<{ name: string; bundle: string; scheme?: string }> = [
  { name: "Zed", bundle: "Zed.app", scheme: "zed" },
  { name: "Zed Preview", bundle: "Zed Preview.app", scheme: "zed" },
  { name: "VS Code", bundle: "Visual Studio Code.app", scheme: "vscode" },
  { name: "VS Code Insiders", bundle: "Visual Studio Code - Insiders.app", scheme: "vscode-insiders" },
  { name: "Cursor", bundle: "Cursor.app", scheme: "cursor" },
  { name: "Windsurf", bundle: "Windsurf.app", scheme: "windsurf" },
  { name: "VSCodium", bundle: "VSCodium.app", scheme: "vscodium" },
  { name: "T3 Code", bundle: "T3 Code.app", scheme: "t3-code" },
  { name: "Codex", bundle: "Codex.app", scheme: "codex" },
  { name: "Kiro", bundle: "Kiro.app", scheme: "kiro" },
  { name: "Trae", bundle: "Trae.app", scheme: "trae" },
  // AI apps without folder deep links: opened with `open -a`.
  { name: "ChatGPT", bundle: "ChatGPT.app" },
  { name: "Claude", bundle: "Claude.app" },
  { name: "bb", bundle: "bb.app" },
];

const APPLICATION_DIRS = ["/Applications", path.join(os.homedir(), "Applications")];

async function bundleScheme(appPath: string): Promise<string | null> {
  const plist = path.join(appPath, "Contents", "Info.plist");
  // Editors ship several URL types (auth callbacks etc.); the first declared
  // scheme is conventionally the deep-link one.
  for (let index = 0; index < 3; index += 1) {
    try {
      const { stdout } = await run("plutil", [
        "-extract",
        `CFBundleURLTypes.${index}.CFBundleURLSchemes.0`,
        "raw",
        plist,
      ]);
      const scheme = stdout.trim();
      if (scheme) return scheme;
    } catch {
      break;
    }
  }
  return null;
}

/** The bundle's real .icns (converted via sips) beats app.getFileIcon, which
    can return a generic icon for .app directories; modern asset-catalog-only
    apps fall through to getFileIcon. */
async function bundleIcon(appPath: string): Promise<string | null> {
  try {
    const plist = path.join(appPath, "Contents", "Info.plist");
    const { stdout } = await run("plutil", ["-extract", "CFBundleIconFile", "raw", plist]);
    const iconName = stdout.trim();
    if (iconName) {
      const icns = path.join(
        appPath,
        "Contents",
        "Resources",
        iconName.endsWith(".icns") ? iconName : `${iconName}.icns`,
      );
      if (existsSync(icns)) {
        const png = path.join(mkdtempSync(path.join(os.tmpdir(), "editor-icon-")), "icon.png");
        await run("sips", ["-s", "format", "png", "-z", "64", "64", icns, "--out", png]);
        const image = nativeImage.createFromPath(png);
        if (!image.isEmpty()) return image.toDataURL();
      }
    }
  } catch {
    // Fall through to getFileIcon.
  }
  try {
    const icon = await app.getFileIcon(appPath, { size: "normal" });
    return icon.isEmpty() ? null : icon.toDataURL();
  } catch {
    return null;
  }
}

let cache: DetectedEditor[] | null = null;

/** Scans the Applications folders for known editor apps, reading each one's
    real URL scheme and icon. Cached for the process lifetime — installing an
    editor mid-session is rare and a relaunch picks it up. */
export async function detectEditors(): Promise<DetectedEditor[]> {
  if (cache) return cache;
  if (process.platform !== "darwin") return (cache = []);
  const detected = await Promise.all(
    CANDIDATES.flatMap((candidate) =>
      APPLICATION_DIRS.map((directory) => ({ candidate, appPath: path.join(directory, candidate.bundle) })),
    )
      .filter(({ appPath }) => existsSync(appPath))
      .map(async ({ candidate, appPath }) => ({
        name: candidate.name,
        scheme: candidate.scheme ? ((await bundleScheme(appPath)) ?? candidate.scheme) : null,
        open: (candidate.scheme ? "scheme" : "app") as "scheme" | "app",
        appPath,
        icon: await bundleIcon(appPath),
      })),
  );
  // /Applications wins over ~/Applications for duplicates.
  const byKey = new Map<string, DetectedEditor>();
  for (const editor of detected) {
    const key = editor.scheme ?? editor.appPath;
    if (!byKey.has(key)) byKey.set(key, editor);
  }
  // Finder closes the list: `open -a Finder <dir>` reveals the folder, so it
  // rides the same open-with path as the AI apps.
  const finder = "/System/Library/CoreServices/Finder.app";
  if (existsSync(finder)) {
    byKey.set(finder, {
      name: "Finder",
      scheme: null,
      open: "app",
      appPath: finder,
      icon: await bundleIcon(finder),
    });
  }
  return (cache = [...byKey.values()]);
}
