/** DRA-37 isolated compute-admission rehearsal fixture. A real Remote Agent
 * server process with its own migrated SQLite database, config, loopback
 * listener and control/ACP sockets, a synthetic ACP primary (test/dra37-agent.ts)
 * and compute admission enabled. Seeds write task/session IDENTITY only;
 * every request, offer, reservation, claim and delivery goes through the
 * server's normal routes and workers. Never points at live config or data. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase } from "../test-support/db.ts";
import { parseServiceFile } from "../lib/config.ts";

const sourceRoot = path.resolve(import.meta.dir, "..");
export const MACHINE = "dra37-machine", REPOSITORY = "dra37-repo";

async function loopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (result.exitCode) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export type Dra37Task = { id: string; sessionId: string; worktree: string; revision: string; recipe: { key: string; purpose: "development"; revision: string; recipeDigest: string } };

export async function dra37Server(options: { slots: number; deliveryTimeoutSeconds?: number }) {
  const port = await loopbackPort();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dra37-")));
  const db = await createTestDatabase();
  const token = crypto.randomUUID(), url = `http://127.0.0.1:${port}`;
  const configFile = path.join(root, "config.json"), controlSocket = path.join(root, "control.sock");
  const repo = path.join(root, "repo"), worktrees = path.join(root, "worktrees"), specs = path.join(root, "specs"), agentLog = path.join(root, "agent.jsonl");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined, collected: Promise<unknown>[] = [], log = "", offset = 0;
  const fixture = {
    root, db, url, token, configFile, controlSocket, agentLog,
    get pid() { return child?.pid; }, get output() { return log; },
    async socket(route: string, init: RequestInit = {}) {
      return fetch(`http://dra37${route}`, { ...init, unix: controlSocket, redirect: "error", signal: init.signal ?? AbortSignal.timeout(10_000) } as RequestInit & { unix: string });
    },
    async agentEvents(): Promise<Array<Record<string, unknown>>> {
      const text = await readFile(agentLog, "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
    /** Identity seed only: task row, its original primary session row and a
     * committed task worktree. No compute, offer, slot or instruction rows. */
    async seedTask(name: string, state: { phase?: string; ownerPaused?: boolean } = {}): Promise<Dra37Task> {
      const worktree = path.join(worktrees, name);
      await mkdir(worktree, { recursive: true });
      git(worktree, "init", "-q", "-b", "main"); git(worktree, "config", "user.name", "DRA-37"); git(worktree, "config", "user.email", "dra37@example.invalid");
      await writeFile(path.join(worktree, "app.txt"), `${name}\n`); git(worktree, "add", "."); git(worktree, "commit", "-qm", `synthetic ${name}`);
      const revision = git(worktree, "rev-parse", "HEAD"), sessionId = `dra37-${name}-primary`, id = `dra37-${name}`;
      await db.prisma.runtimeSession.create({ data: { id: sessionId, scopeKey: `dra37:${name}`, agentCommand: "codex", repositoryId: REPOSITORY, machineId: MACHINE,
        role: "primary", lifecycle: "persistent", cwd: worktree, worktreePath: worktree, status: "idle", name: `DRA-37 ${name}` } });
      await db.prisma.remoteTask.create({ data: { id, requestKey: `dra37:${name}`, repositoryId: REPOSITORY, machineId: MACHINE, branchName: `dra37/${name}`, worktreePath: worktree,
        toolingRoot: repo, toolingRevision: "0".repeat(40), primarySessionId: sessionId, phase: state.phase ?? "working", ownerPaused: state.ownerPaused ?? false } });
      const recipe = { key: `app-${name}`, purpose: "development" as const, revision, recipeDigest: Bun.CryptoHasher.hash("sha256", `recipe:${name}`, "hex") as string };
      await mkdir(specs, { recursive: true });
      await writeFile(path.join(specs, `${id}.json`), JSON.stringify(recipe));
      return { id, sessionId, worktree, revision, recipe };
    },
    /** The adapter's request, through the normal route on the control socket. */
    async requestCompute(task: Dra37Task) {
      const response = await fixture.socket(`/api/tasks/${encodeURIComponent(task.id)}/compute-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task.recipe) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    async start() {
      offset = log.length;
      // Explicit environment: no inherited REMOTE_AGENT_* or provider secrets.
      child = Bun.spawn([process.execPath, "apps/server/server.ts"], { cwd: sourceRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: root, REMOTE_AGENT_CONFIG: configFile, DRA37_LOG: agentLog, DRA37_SPECS: specs, DRA37_SOCKET: controlSocket } });
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader(), decoder = new TextDecoder();
        for (;;) { const part = await reader.read(); if (part.done) break; log += decoder.decode(part.value, { stream: true }); }
      };
      collected = [consume(child.stdout), consume(child.stderr)];
      const until = Date.now() + 40_000;
      while (Date.now() < until) {
        if (child.exitCode !== null) throw new Error(`DRA-37 server exited ${child.exitCode}\n${log.slice(offset).slice(-8_000)}`);
        if (log.slice(offset).includes(`remote-agent listening on ${url}`)) {
          try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* not ready */ }
        }
        await Bun.sleep(50);
      }
      throw new Error(`DRA-37 server startup timed out\n${log.slice(offset).slice(-8_000)}`);
    },
    async stop() {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        const current = child, limit = setTimeout(() => { if (current.exitCode === null) current.kill("SIGKILL"); }, 15_000);
        try { await current.exited; } finally { clearTimeout(limit); }
      }
      await Promise.all(collected);
      await writeFile(path.join(root, "server.log"), log, { mode: 0o600 });
    },
    async cleanup(options: { keepEvidence?: boolean } = {}) {
      await fixture.stop(); await db.cleanup();
      if (!options.keepEvidence) await rm(root, { recursive: true, force: true });
    },
  };
  try {
    await mkdir(repo); git(repo, "init", "-q");
    await writeFile(path.join(repo, ".remote-agent.config.json"), "{}\n");
    const config = parseServiceFile({
      schemaVersion: 2, serviceName: "dra37-compute-rehearsal",
      machine: { id: MACHINE, name: "DRA-37 isolated rehearsal",
        server: { publicUrl: url, apiKey: token, listen: { host: "127.0.0.1", port }, databaseUrl: db.databaseUrl,
          acpSocketPath: path.join(root, "acp.sock"), controlSocketPath: controlSocket },
        acpx: { stateDir: path.join(root, "acpx"), maxConcurrentTurns: 4 }, installation: { root: path.join(root, "install") },
        compute: { enabled: true, slots: options.slots, deliveryTimeoutSeconds: options.deliveryTimeoutSeconds ?? 30, collectorFreshnessSeconds: 15 } },
      providers: { codex: { command: [process.execPath, path.join(import.meta.dir, "dra37-agent.ts")] }, claude: { command: [process.execPath, path.join(import.meta.dir, "dra37-agent.ts")] } },
      connections: {}, repositories: { [REPOSITORY]: { root: repo, worktreeRoot: worktrees } },
    });
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}
