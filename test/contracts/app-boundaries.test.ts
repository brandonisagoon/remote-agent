import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { repoRoot } from "../../test-support/repo.ts";

const ROOT = repoRoot();

/** The kernel the desktop app and CLI may reach. `lib/` is only the shared
    kernel (config, skills, machines) — Prisma, services, integrations,
    workers, and Hono live under apps/server and are server-only. This test
    is the enforcement the flat single-package layout doesn't get from
    package boundaries. */
const KERNEL_PREFIXES = [
  "lib/",
  "management/",
  "types/",
  "remote-agent.config.example.json",
  "remote-agent.config.schema.json",
];

function tsFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      collected.push(...tsFiles(full));
    } else if (/\.(ts|tsx|mts)$/.test(entry)) {
      collected.push(full);
    }
  }
  return collected;
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

/** Walks the app's import graph TRANSITIVELY: a kernel file that itself
    reaches into apps/server would silently drag the server into an app
    bundle, so kernel files reachable from an app are checked too. */
function violations(appDirectory: string): string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  const queue = tsFiles(path.join(ROOT, appDirectory)).map((file) =>
    path.relative(ROOT, file).replace(/\\/g, "/"),
  );
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = path
        .relative(ROOT, path.resolve(ROOT, path.dirname(file), match[1]!))
        .replace(/\\/g, "/");
      if (resolved.startsWith("out/")) continue; // build products (preload cjs)
      const inApp = resolved.startsWith(`${appDirectory}/`);
      const inKernel = KERNEL_PREFIXES.some(
        (prefix) => resolved === prefix || resolved.startsWith(prefix),
      );
      if (!inApp && !inKernel) {
        found.push(`${file} -> ${resolved}`);
        continue;
      }
      if (/\.(ts|tsx|mts)$/.test(resolved)) queue.push(resolved);
    }
  }
  return found;
}

describe("app dependency boundaries", () => {
  test("the desktop app only reaches the kernel", () => {
    expect(violations("apps/desktop")).toEqual([]);
  });

  test("the CLI only reaches the kernel", () => {
    expect(violations("apps/cli")).toEqual([]);
  });
});
