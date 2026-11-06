/**
 * DRA-37 task-owned synthetic tooling for test/dra37-capacity-retirement.rehearsal.ts.
 *
 * Creates a PRIVATE committed tooling repository the isolated server uses as
 * its configured-host tooling. Its runtime capability adapter is a synthetic
 * observer: no Docker, provider or network. Every invocation is appended to
 * <server root>/synthetic-observer/calls.jsonl; while
 * <server root>/synthetic-observer/mode reads "unavailable" (the default) it
 * exits non-zero, so the server's physical accounting has no proof. The
 * server verifies the adapter exactly as it verifies Drafted's (committed
 * bytes, clean checkout, manifest contracts) and runs it as an owned observer.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Runs from <install>/tooling/<repository>/<revision>; the control directory is
// beside the install root, inside the private server root.
const ADAPTER = `import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
const control = path.resolve(import.meta.dir, "..", "..", "..", "..", "synthetic-observer");
mkdirSync(control, { recursive: true });
const input = await new Response(Bun.stdin.stream()).text().catch(() => "");
const mode = existsSync(path.join(control, "mode")) ? readFileSync(path.join(control, "mode"), "utf8").trim() : "unavailable";
appendFileSync(path.join(control, "calls.jsonl"), JSON.stringify({ at: Date.now(), pid: process.pid, args: process.argv.slice(2), mode, inputBytes: input.length }) + "\\n");
if (process.argv[2] === "compute" && mode === "unavailable") { process.stderr.write("synthetic observer: physical inventory unavailable\\n"); process.exit(3); }
process.stderr.write("synthetic observer: unsupported command\\n"); process.exit(2);
`;

const FILES: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": JSON.stringify({ name: "dra37-synthetic-tooling", private: true }) + "\n",
  ".remote-agent.config.json": JSON.stringify({ baseBranch: "main", preparation: "agent" }) + "\n",
  ".remote-agent-capabilities.json": JSON.stringify({ version: 1, capabilities: {
    prepare: { instructions: "capabilities/prepare.md", adapter: "adapter.ts" },
    runtime: { instructions: "capabilities/runtime.md", adapter: "adapter.ts", observationContracts: ["compute-traffic/v1", "compute-baseline/v1"] },
  } }, null, 2) + "\n",
  "capabilities/prepare.md": "Synthetic DRA-37 preparation: do no work.\n",
  "capabilities/runtime.md": "Synthetic DRA-37 runtime observer: no physical runtime exists.\n",
  "adapter.ts": ADAPTER,
};

export async function createSyntheticTooling(root: string, git: (cwd: string, ...args: string[]) => Promise<string>) {
  const source = path.join(root, "synthetic-tooling-source");
  await mkdir(path.join(source, "capabilities"), { recursive: true });
  for (const [name, content] of Object.entries(FILES)) await writeFile(path.join(source, name), content, { mode: 0o644 });
  await git(source, "init", "--quiet", "-b", "main");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "DRA-37 synthetic tooling");
  const revision = (await git(source, "rev-parse", "HEAD")).trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  return { source, revision, control: path.join(root, "synthetic-observer"), adapter: ADAPTER };
}
