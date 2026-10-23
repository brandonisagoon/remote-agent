import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RepositoryConfig } from "../../../../lib/config.ts";

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

const preparing = new Map<string, Promise<string>>();

/** One immutable source checkout per revision. Dependencies are installed in
 * the tooling checkout, never added to the product. An abandoned lock is
 * reported for investigation rather than guessed safe to steal. */
export async function prepareTooling(repository: RepositoryConfig, installRoot: string): Promise<string> {
  if (!repository.tooling) return repository.root;
  const source = repository.tooling;
  const destination = path.join(installRoot, "tooling", repository.id, source.revision);
  const existing = preparing.get(destination);
  if (existing) return existing;
  const operation = (async () => {
    mkdirSync(path.dirname(destination), { recursive: true });
    const lock = `${destination}.lock`;
    try { mkdirSync(lock); } catch { throw new Error(`Tooling preparation lock exists: ${lock}. Reconcile the prior attempt before retrying.`); }
    try {
      if (!existsSync(destination)) {
        await run(["git", "worktree", "add", "--detach", destination, source.revision], source.root);
      }
      const actual = await run(["git", "rev-parse", "HEAD"], destination);
      if (actual !== source.revision) throw new Error("Tooling checkout revision does not match its receipt");
      if (await run(["git", "status", "--porcelain", "--untracked-files=normal"], destination)) throw new Error("Pinned tooling checkout has local changes; preserve and reconcile them before reuse");
      if (!existsSync(`${destination}.ready`)) {
        await run([process.execPath, "install", "--frozen-lockfile"], destination);
        writeFileSync(`${destination}.ready`, `${source.revision}\n`, { mode: 0o600 });
      } else if (readFileSync(`${destination}.ready`, "utf8").trim() !== source.revision) {
        throw new Error("Tooling installation receipt does not match its revision");
      }
      return destination;
    } finally { rmSync(lock, { recursive: true }); }
  })();
  preparing.set(destination, operation);
  try { return await operation; } finally { preparing.delete(destination); }
}
