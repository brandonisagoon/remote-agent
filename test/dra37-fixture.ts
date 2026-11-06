/** DRA-37 isolated compute-admission rehearsal fixture. A real Remote Agent
 * server process with its own migrated SQLite database, config, loopback
 * listener and control/ACP sockets, a synthetic ACP primary (test/dra37-agent.ts)
 * and compute admission enabled. Seeds write task/session IDENTITY only;
 * every request, offer, reservation, claim and delivery goes through the
 * server's normal routes and workers. Never points at live config or data. */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * DEPENDENCY-INJECTED PARTIAL REHEARSAL of tooling preparation, not release
 * acceptance. The configured source is a `--shared` clone of the paired
 * Drafted repository (it only reads the paired objects) at the exact commit,
 * and the checkout at the server's install path is a detached worktree of
 * that commit. Its dependencies are a SYMLINK to the paired checkout's
 * mutable node_modules and its legacy `.ready` receipt is written here: no
 * frozen install, install receipt, worktree lock or prepareToolingRelease
 * verification happens. Final real-release acceptance must use the
 * supported preparation against an isolated clone with frozen dependencies.
 */
async function prepareDraftedTooling(root: string, install: string, revision: string, paired: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("The DRA-37 runtime rehearsal requires an exact 40-character Drafted commit");
  if (!existsSync(path.join(paired, ".git")) || !existsSync(path.join(paired, "node_modules"))) throw new Error(`Paired Drafted source ${paired} must be a git checkout with installed node_modules`);
  const source = path.join(root, "tooling-source");
  const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-checkout", "--shared", paired, source], { stdout: "pipe", stderr: "pipe" });
  if (clone.exitCode) throw new Error(`Cannot clone Drafted: ${clone.stderr.toString()}`);
  const full = git(source, "rev-parse", "--verify", `${revision}^{commit}`), tree = git(source, "rev-parse", `${full}^{tree}`);
  // The dependency link is a symlink; Drafted ignores only a node_modules
  // directory. Exclude it in this temporary clone's own metadata.
  await writeFile(path.join(source, ".git", "info", "exclude"), "node_modules\n", { flag: "a" });
  const checkout = path.join(install, "tooling", REPOSITORY, full);
  await mkdir(path.dirname(checkout), { recursive: true });
  git(source, "worktree", "add", "--detach", checkout, full);
  await symlink(path.join(paired, "node_modules"), path.join(checkout, "node_modules"));
  if (git(checkout, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Prepared Drafted checkout is not clean");
  await writeFile(`${checkout}.ready`, `${full}\n`, { mode: 0o600 });
  return { source, root: checkout, revision: full, tree,
    preparation: "dependency-injected partial rehearsal: symlinked paired node_modules and fixture-written .ready; not frozen install verification" };
}

/** Real-Docker mode inputs, recorded before any effect. */
export const REAL_IMAGES = { app: "oven/bun:1.3.14", proxy: "nginx:1.28-alpine" } as const;
type RealDocker = { docker: string; prefix: string; images: { app: string; proxy: string }; ledger: string; policy: string };

export async function dra37Server(options: { slots: number; deliveryTimeoutSeconds?: number; drafted?: { source: string; revision: string }; relay?: boolean; docker?: "synthetic" | "real" }) {
  const port = await loopbackPort();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dra37-")));
  const db = await createTestDatabase();
  const token = crypto.randomUUID(), url = `http://127.0.0.1:${port}`;
  const configFile = path.join(root, "config.json"), controlSocket = path.join(root, "control.sock");
  const repo = path.join(root, "repo"), worktrees = path.join(root, "worktrees"), specs = path.join(root, "specs"), agentLog = path.join(root, "agent.jsonl");
  const apps = path.join(root, "apps"), state = path.join(root, "state"), bin = path.join(root, "bin");
  await mkdir(apps, { mode: 0o700 }); await mkdir(state, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  // SYNTHETIC Docker CLI, first on the server's PATH only, for Drafted's
  // actual observer (see dra37-docker.ts). The app it reports is real.
  // Executable Bun/TypeScript shim (no shell): forwards argv unchanged after
  // this fixture's exact records path; it adds nothing to the observer's
  // whitelisted environment.
  let real: RealDocker | null = null;
  if (options.docker === "real") {
    // REAL Docker, behind the fixture policy guard (dra37-docker-guard.ts).
    // Image IDs are recorded from images already present: never pulled.
    const docker = Bun.which("docker");
    if (!docker) throw new Error("Real-Docker DRA-37 mode requires the docker CLI");
    const imageId = (tag: string) => {
      const result = Bun.spawnSync([docker, "image", "inspect", tag, "--format", "{{.Id}}"], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode) throw new Error(`Required local image ${tag} is not present; it is never pulled`);
      return result.stdout.toString().trim();
    };
    real = { docker, prefix: `dra37fx-${path.basename(root).replace(/^dra37-/, "").toLowerCase()}`, images: { app: imageId(REAL_IMAGES.app), proxy: imageId(REAL_IMAGES.proxy) },
      ledger: path.join(root, "docker-ledger.jsonl"), policy: path.join(root, "docker-policy.json") };
    await writeFile(real.policy, JSON.stringify({ root, prefix: real.prefix, docker, images: Object.values(real.images), ledger: real.ledger, log: path.join(apps, "docker-calls.jsonl") }), { mode: 0o600 });
    await writeFile(path.join(bin, "docker"), [`#!${process.execPath} --no-env-file`,
      `process.argv.splice(2, 0, ${JSON.stringify(real.policy)});`,
      `await import(${JSON.stringify(path.join(import.meta.dir, "dra37-docker-guard.ts"))});`, ""].join("\n"), { mode: 0o700 });
  } else {
    await writeFile(path.join(bin, "docker"), [`#!${process.execPath} --no-env-file`,
      `process.argv.splice(2, 0, ${JSON.stringify(apps)});`,
      `await import(${JSON.stringify(path.join(import.meta.dir, "dra37-docker.ts"))});`, ""].join("\n"), { mode: 0o700 });
  }
  const install = path.join(root, "install");
  const drafted = options.drafted ? await prepareDraftedTooling(root, install, options.drafted.revision, options.drafted.source) : null;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined, collected: Promise<unknown>[] = [], log = "", offset = 0;
  const fixture = {
    root, db, url, token, configFile, controlSocket, agentLog, apps, state, drafted, real,
    /** Exact fixture-created Docker objects, in creation order. */
    dockerLedger(): Array<{ kind: "container" | "network" | "volume"; id: string; name?: string }> {
      return real && existsSync(real.ledger) ? readFileSync(real.ledger, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    },
    /** Environment for one actual Drafted runtime invocation (dra37-runtime-turn.ts). */
    runtimeEnv(taskId: string) {
      if (!drafted) throw new Error("This fixture has no pinned Drafted checkout");
      return { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: tmpdir(), HOME: root, DRA37_DRAFTED_ROOT: drafted.root, DRA37_SOCKET: controlSocket,
        ...(real ? { DRA37_DOCKER_MODE: "real" } : {}),
        DRA37_TASK: taskId, DRA37_STATE: state, DRA37_RECIPE: path.join(specs, `${taskId}.recipe.json`), DRA37_APPS: apps, ...(options.relay === false ? { DRA37_RELAY: "0" } : {}) };
    },
    async runtimeTurn(taskId: string, action: "up" | "stop" | "status", offer?: string) {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "dra37-runtime-turn.ts"), action, ...(offer ? [offer] : [])],
        { cwd: path.join(worktrees, taskId.replace(/^dra37-/, "")), stdout: "pipe", stderr: "pipe", env: fixture.runtimeEnv(taskId) });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, result: code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown> : null };
    },
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
      await writeFile(path.join(worktree, "app.txt"), `${name}\n`);
      // Synthetic product app for real-Docker mode (runs inside the container).
      await writeFile(path.join(worktree, "app.ts"), `// Drafted's supported activity publisher (same pattern as its lot-test
// server): this synthetic service has no background work, so its complete
// coverage reports only request lifetimes.
const environment = process.env;
let activity: { begin(kind: "background-job"): Promise<() => void> } | undefined;
if (environment.DRAFTED_COMPUTE_ACTIVITY_MODULE === "/run/drafted/compute-activity.js" && environment.DRAFTED_COMPUTE_ACTIVITY_DIRECTORY && environment.DRAFTED_COMPUTE_ACTIVITY_SERVICE) {
  const module = await import(environment.DRAFTED_COMPUTE_ACTIVITY_MODULE);
  activity = await module.createComputeActivitySource(environment.DRAFTED_COMPUTE_ACTIVITY_DIRECTORY, environment.DRAFTED_COMPUTE_ACTIVITY_SERVICE, { coverage: "complete" });
}
Bun.serve({ hostname: "0.0.0.0", port: 8080, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ready: true, taskId: ${JSON.stringify(`dra37-${name}`)}, pid: process.pid, activity: Boolean(activity) });
  if (url.pathname === "/") return new Response("<!doctype html><title>DRA-37 ${name}</title><h1>DRA-37 synthetic task app ${name}</h1>", { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
} });
`);
      if (real) {
        // The synthetic PRODUCT's own schema tool. Drafted runs the product's
        // `prisma db push` in its container; providers are synthetic (no real
        // database), so this product tool records the request and succeeds.
        const tool = path.join(worktree, "tools", "prisma-fixture");
        await mkdir(tool, { recursive: true });
        await writeFile(path.join(tool, "package.json"), JSON.stringify({ name: "dra37-prisma-fixture", version: "1.0.0", bin: { prisma: "cli.js" } }));
        await writeFile(path.join(tool, "cli.js"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== "db" || args[1] !== "push") { console.error("DRA-37 synthetic product prisma supports only db push"); process.exit(2); }
console.log(JSON.stringify({ dra37SyntheticSchemaPush: true, args, databaseConfigured: Boolean(process.env.DATABASE_URL) }));
`, { mode: 0o755 });
        await writeFile(path.join(worktree, "package.json"), JSON.stringify({ name: `dra37-${name}`, private: true, dependencies: { "dra37-prisma-fixture": "file:./tools/prisma-fixture" } }));
        await writeFile(path.join(worktree, ".gitignore"), "node_modules\n");
        const install = Bun.spawnSync([process.execPath, "install"], { cwd: worktree, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } });
        if (install.exitCode) throw new Error(`Synthetic product lockfile could not be created offline: ${install.stderr.toString().slice(-500)}`);
      }
      git(worktree, "add", "."); git(worktree, "commit", "-qm", `synthetic ${name}`);
      const revision = git(worktree, "rev-parse", "HEAD"), sessionId = `dra37-${name}-primary`, id = `dra37-${name}`;
      await db.prisma.runtimeSession.create({ data: { id: sessionId, scopeKey: `dra37:${name}`, agentCommand: "codex", repositoryId: REPOSITORY, machineId: MACHINE,
        role: "primary", lifecycle: "persistent", cwd: worktree, worktreePath: worktree, status: "idle", name: `DRA-37 ${name}` } });
      await db.prisma.remoteTask.create({ data: { id, requestKey: `dra37:${name}`, repositoryId: REPOSITORY, machineId: MACHINE, branchName: `dra37/${name}`, worktreePath: worktree,
        toolingRoot: drafted?.source ?? repo, toolingRevision: drafted?.revision ?? "0".repeat(40), ...(drafted ? { pinnedToolingRoot: drafted.root } : {}),
        primarySessionId: sessionId, phase: state.phase ?? "working", ownerPaused: state.ownerPaused ?? false } });
      const recipe = { key: `app-${name}`, purpose: "development" as const, revision, recipeDigest: Bun.CryptoHasher.hash("sha256", `recipe:${name}`, "hex") as string };
      await mkdir(specs, { recursive: true });
      await writeFile(path.join(specs, `${id}.json`), JSON.stringify(recipe));
      // Private Drafted recipe for the actual runtime algorithm. Its PlanetScale
      // identity is a fixture value: the provider transport is synthetic.
      const credentialsFile = path.join(specs, `${id}.credentials.json`);
      await writeFile(credentialsFile, JSON.stringify({ CLERK_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_fixture" }), { mode: 0o600 });
      await writeFile(path.join(specs, `${id}.recipe.json`), JSON.stringify({ version: 1, profile: "platform", image: real ? REAL_IMAGES.app : "dra37-synthetic:1", credentialsFile,
        runtimeSecrets: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"], planetscale: { organization: "fixture", database: "fixture", baseBranch: "main", baseBranchId: "base" },
        ...(real ? { setup: [["bun", "install", "--frozen-lockfile"]] } : {}),
        services: { api: { command: ["bun", "app.ts"], port: 8080 } }, checks: [{ service: "api", path: "/health", representative: true, json: { ready: true } }], traffic: { operations: "none" }, readyTimeoutSeconds: 15 }), { mode: 0o600 });
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
        env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: tmpdir(), LANG: "en_US.UTF-8", HOME: root, REMOTE_AGENT_CONFIG: configFile, DRA37_LOG: agentLog, DRA37_SPECS: specs, DRA37_SOCKET: controlSocket,
          ...(drafted ? { DRA37_DRAFTED_ROOT: drafted.root, DRA37_STATE: state, DRA37_APPS: apps } : {}), ...(options.relay === false ? { DRA37_RELAY: "0" } : {}),
          ...(real ? { DRA37_DOCKER_MODE: "real" } : {}) } });
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
      await fixture.stop();
      if (real) {
        // Exact ledger objects only, through normal stop/rm, newest first.
        const results: unknown[] = [];
        const run = (args: string[]) => { const result = Bun.spawnSync([real!.docker, ...args], { stdout: "pipe", stderr: "pipe" }); results.push({ args, code: result.exitCode, stderr: result.stderr.toString().trim().slice(0, 300) }); };
        const entries = fixture.dockerLedger().reverse();
        for (const entry of entries.filter(value => value.kind === "container")) { run(["stop", entry.id]); run(["rm", entry.id]); }
        for (const entry of entries.filter(value => value.kind === "network")) run(["network", "rm", entry.id]);
        for (const entry of entries.filter(value => value.kind === "volume")) run(["volume", "rm", entry.id]);
        await writeFile(path.join(root, "docker-cleanup.json"), JSON.stringify({ ledger: fixture.dockerLedger(), results }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ dockerCleanup: results }));
      }
      await db.cleanup();
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
        acpx: { stateDir: path.join(root, "acpx"), maxConcurrentTurns: 4 }, installation: { root: install },
        compute: { enabled: true, slots: options.slots, deliveryTimeoutSeconds: options.deliveryTimeoutSeconds ?? 30, collectorFreshnessSeconds: 15 } },
      providers: { codex: { command: [process.execPath, path.join(import.meta.dir, "dra37-agent.ts")] }, claude: { command: [process.execPath, path.join(import.meta.dir, "dra37-agent.ts")] } },
      connections: {}, repositories: { [REPOSITORY]: { root: repo, worktreeRoot: worktrees, ...(drafted ? { tooling: { root: drafted.source, ref: drafted.revision } } : {}) } },
    });
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}
