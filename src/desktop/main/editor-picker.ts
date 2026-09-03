import { execFile } from "node:child_process";
import path from "node:path";
import { dialog } from "electron";

export interface PickedEditor {
  name: string;
  scheme: string;
  appPath: string;
}

/** Opens a native picker for an .app bundle and extracts its URL scheme
    from Info.plist. Returns null when cancelled or reason when unusable. */
export async function pickEditor(): Promise<
  { editor: PickedEditor } | { error: "no-url-scheme" } | null
> {
  const result = await dialog.showOpenDialog({
    title: "Choose Editor",
    defaultPath: "/Applications",
    properties: ["openFile"],
    filters: [{ name: "Applications", extensions: ["app"] }],
  });
  const appPath = result.filePaths[0];
  if (result.canceled || !appPath) return null;

  const plist = path.join(appPath, "Contents", "Info.plist");
  const info = await new Promise<Record<string, unknown> | null>((resolve) => {
    execFile("plutil", ["-convert", "json", "-o", "-", plist], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
  });
  if (!info) return { error: "no-url-scheme" };

  const urlTypes = info["CFBundleURLTypes"] as Array<{ CFBundleURLSchemes?: string[] }> | undefined;
  const scheme = urlTypes?.flatMap((type) => type.CFBundleURLSchemes ?? [])[0];
  if (!scheme) return { error: "no-url-scheme" };

  const name =
    (info["CFBundleDisplayName"] as string | undefined) ??
    (info["CFBundleName"] as string | undefined) ??
    path.basename(appPath, ".app");
  return { editor: { name, scheme, appPath } };
}
