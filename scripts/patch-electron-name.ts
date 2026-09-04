#!/usr/bin/env bun
// Dev-only branding: the menu-bar title and Dock label come from the Electron
// dist bundle itself (its Info.plist and even its folder name), so
// `electron-vite dev` shows "Electron" no matter what app.setName says.
// Rename the bundle, patch its names, and re-sign ad-hoc. Idempotent; wired
// to postinstall so reinstalls stay patched. Packaged builds are unaffected —
// electron-builder produces its own bundle.
import { $ } from "bun";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") process.exit(0);

const electronRoot = path.resolve(import.meta.dir, "..", "node_modules", "electron");
const dist = path.join(electronRoot, "dist");
const stock = path.join(dist, "Electron.app");
const branded = path.join(dist, "Remote Agent.app");

// The Dock/Finder display name follows the bundle's file name; rename it and
// point the electron launcher's path.txt at the new location.
if (existsSync(stock)) {
  renameSync(stock, branded);
  const pathFile = path.join(electronRoot, "path.txt");
  const current = await Bun.file(pathFile).text();
  await Bun.write(pathFile, current.replace("Electron.app", "Remote Agent.app"));
}
if (!existsSync(branded)) process.exit(0);

const plist = path.join(branded, "Contents", "Info.plist");
const current = await $`plutil -extract CFBundleName raw ${plist}`.text();
if (current.trim() !== "Remote Agent") {
  await $`plutil -replace CFBundleName -string "Remote Agent" ${plist}`;
  await $`plutil -replace CFBundleDisplayName -string "Remote Agent" ${plist}`;
  // The Dock prefers the localized display name; the lproj ships empty.
  await Bun.write(
    path.join(branded, "Contents", "Resources", "en.lproj", "InfoPlist.strings"),
    'CFBundleName = "Remote Agent";\nCFBundleDisplayName = "Remote Agent";\n',
  );
  // Editing the plist invalidates Electron's signature.
  await $`codesign --force --deep --sign - ${branded}`.quiet();
}

// LaunchServices caches display names per bundle path.
await $`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ${branded}`.quiet();
console.log("Patched Electron dev bundle to Remote Agent.app");
