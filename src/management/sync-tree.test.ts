import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncTree } from "./sync-tree.ts";

let root: string;
let from: string;
let to: string;

function write(base: string, relative: string, content: string) {
  const file = path.join(base, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sync-tree-"));
  from = path.join(root, "from");
  to = path.join(root, "to");
  mkdirSync(from);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncTree", () => {
  test("copies new and changed files and deletes removed ones", () => {
    write(from, "src/app.ts", "new");
    write(from, "package.json", "{}");
    write(to, "src/app.ts", "old");
    write(to, "src/removed.ts", "gone");
    syncTree(from, to);
    expect(readFileSync(path.join(to, "src/app.ts"), "utf8")).toBe("new");
    expect(readFileSync(path.join(to, "package.json"), "utf8")).toBe("{}");
    expect(existsSync(path.join(to, "src/removed.ts"))).toBeFalse();
  });

  test("never copies .git or node_modules and preserves target-only build products", () => {
    write(from, ".git/HEAD", "ref");
    write(from, "node_modules/dep/index.js", "src dep");
    write(from, "src/app.ts", "code");
    write(to, "node_modules/dep/index.js", "installed dep");
    write(to, "src/generated/prisma/client.ts", "generated");
    syncTree(from, to);
    expect(existsSync(path.join(to, ".git"))).toBeFalse();
    expect(readFileSync(path.join(to, "node_modules/dep/index.js"), "utf8")).toBe("installed dep");
    expect(readFileSync(path.join(to, "src/generated/prisma/client.ts"), "utf8")).toBe("generated");
  });

  test("replaces a file with a directory when the layout changes", () => {
    write(from, "docs/readme.md", "dir now");
    write(to, "docs", "was a file");
    syncTree(from, to);
    expect(readFileSync(path.join(to, "docs/readme.md"), "utf8")).toBe("dir now");
  });
});
