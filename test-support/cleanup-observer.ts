import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** A real committed subprocess capability. Caller owns its disposable parent. */
export async function cleanupObserverFixture(parent: string, source: string) {
  const checkout = path.join(await realpath(parent), "observer");
  await mkdir(checkout, { mode: 0o700 });
  const adapter = path.join(checkout, "adapter.ts");
  await writeFile(adapter, source, { mode: 0o600 });
  await writeFile(path.join(checkout, ".remote-agent-capabilities.json"), JSON.stringify({ version: 1, capabilities: { cleanup: { adapter: "adapter.ts" } } }), { mode: 0o600 });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error("Disposable observer Git fixture failed");
    return result.stdout.toString().trim();
  };
  git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "--quiet", "-m", "Pinned observer fixture");
  return { version: 1 as const, source: "configured-host" as const, checkout, adapter, revision: git("rev-parse", "HEAD"), adapterSha256: createHash("sha256").update(source).digest("hex") };
}

/** Uses a caller-selected clean checkout; normal production verification still
 * validates the entire pinned capability before and after the actual CLI. */
export async function existingCleanupObserverFixture(root: string) {
  const checkout = await realpath(root), adapter = path.join(checkout, "src/cli.ts");
  const git = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (git.exitCode) throw new Error("Integration fixture must be a Git checkout");
  return { version: 1 as const, source: "configured-host" as const, checkout, adapter, revision: git.stdout.toString().trim(), adapterSha256: createHash("sha256").update(await readFile(adapter)).digest("hex") };
}
