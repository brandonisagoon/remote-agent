import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** Directory names never copied from the source (any depth). */
const EXCLUDED_NAMES = new Set([".git", "node_modules"]);
/** Source-relative paths never copied. */
const EXCLUDED_PATHS = new Set([path.join("src", "generated")]);

/** Portable stand-in for `rsync -a --delete` with the deploy excludes: copies
    `from` over `to`, removes files that no longer exist in `from`, but leaves
    the build products that live only in `to` (node_modules, the generated
    Prisma client) untouched. */
export function syncTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  copyInto(from, to, "");
  deleteExtraneous(from, to, "");
}

function excluded(relative: string): boolean {
  return EXCLUDED_NAMES.has(path.basename(relative)) || EXCLUDED_PATHS.has(relative);
}

function copyInto(fromRoot: string, toRoot: string, relative: string): void {
  for (const entry of readdirSync(path.join(fromRoot, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (excluded(entryRelative)) continue;
    const source = path.join(fromRoot, entryRelative);
    const target = path.join(toRoot, entryRelative);
    if (entry.isDirectory()) {
      // A file may occupy the target path from an older layout; clear it.
      if (existsSync(target) && !statSync(target).isDirectory()) rmSync(target);
      mkdirSync(target, { recursive: true });
      copyInto(fromRoot, toRoot, entryRelative);
    } else {
      // The inverse layout change: a directory may occupy the file's path.
      if (existsSync(target) && statSync(target).isDirectory()) {
        rmSync(target, { recursive: true, force: true });
      }
      cpSync(source, target, { force: true });
    }
  }
}

function deleteExtraneous(fromRoot: string, toRoot: string, relative: string): void {
  for (const entry of readdirSync(path.join(toRoot, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    if (excluded(entryRelative)) continue;
    const source = path.join(fromRoot, entryRelative);
    const target = path.join(toRoot, entryRelative);
    if (!existsSync(source)) {
      rmSync(target, { recursive: true, force: true });
    } else if (entry.isDirectory() && statSync(source).isDirectory()) {
      deleteExtraneous(fromRoot, toRoot, entryRelative);
    }
  }
}
