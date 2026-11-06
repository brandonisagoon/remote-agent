import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase } from "./db.ts";
import { parseServiceFile } from "../lib/config.ts";

const sourceRoot = path.resolve(import.meta.dir, "..");

async function unusedLoopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Real server entrypoint, with no inherited live config, service sockets,
 * provider credentials or source connections. This fixture supplies its own
 * migrated SQLite database and acpx namespace; restart reuses only those.
 * The default provider command refuses execution until a test explicitly
 * supplies its synthetic provider. Never point this fixture at a live DB. */
export async function isolatedServer() {
  // Fail before creating a database if the host cannot bind loopback ports.
  const port = await unusedLoopbackPort();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ra-server-")));
  const db = await createTestDatabase();
  const token = crypto.randomUUID();
  const configFile = path.join(root, "config.json");
  const controlSocket = path.join(root, "control.sock");
  const repo = path.join(root, "repo");
  const logFile = path.join(root, "server.log");
  const url = `http://127.0.0.1:${port}`;
  const refuseProvider = path.join(root, "refuse-provider.ts");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let collected: Promise<unknown>[] = [];
  let log = "";
  let boots = 0;
  let startupOffset = 0;
  const fixture = {
    root, db, configFile, controlSocket, token, url, logFile,
    get pid() { return child?.pid; },
    get output() { return log; },
    async request(route: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(`${url}${route}`, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(5_000) });
    },
    async socketRequest(route: string, init: RequestInit = {}) {
      return fetch(`http://isolated${route}`, { ...init, unix: controlSocket, redirect: "error", signal: init.signal ?? AbortSignal.timeout(5_000) });
    },
    async start() {
      if (child && child.exitCode === null) throw new Error("Isolated server is already running");
      startupOffset = log.length;
      boots++;
      // Explicit environment: do not spread a source-work session's live
      // REMOTE_AGENT_CONFIG/SOCKET/SESSION_ID or provider account secrets.
      child = Bun.spawn([process.execPath, "apps/server/server.ts"], {
        cwd: sourceRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", REMOTE_AGENT_CONFIG: configFile },
      });
      const consume = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader(), decoder = new TextDecoder();
        for (;;) { const part = await reader.read(); if (part.done) break; log += decoder.decode(part.value, { stream: true }); }
        log += decoder.decode();
      };
      collected = [consume(child.stdout), consume(child.stderr)];
      const until = Date.now() + 40_000;
      try {
        while (Date.now() < until) {
          if (child.exitCode !== null) throw new Error(`Isolated server exited ${child.exitCode}`);
          // Do not mistake an unrelated listener winning the ephemeral-port
          // race for this child. It must have announced this exact listener.
          if (log.slice(startupOffset).includes(`remote-agent listening on ${url}`)) {
            try {
              const response = await fixture.request("/health");
              if (response.ok && (await response.json() as { status?: string }).status === "ok") return;
            } catch { /* Startup can precede socket readiness. */ }
          }
          await Bun.sleep(50);
        }
        throw new Error("Isolated server startup timed out");
      } catch (error) {
        await fixture.stop();
        throw new Error(`${String(error)}\n${log.slice(startupOffset).slice(-12_000)}\nEvidence: ${logFile}`);
      }
    },
    async stop() {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        const current = child;
        const limit = setTimeout(() => { if (current.exitCode === null) current.kill("SIGKILL"); }, 15_000);
        try { await current.exited; } finally { clearTimeout(limit); }
      }
      await Promise.all(collected);
      await writeFile(logFile, log, { mode: 0o600 });
    },
    async cleanup(options: { keepEvidence?: boolean } = {}) {
      await fixture.stop();
      await db.cleanup();
      if (!options.keepEvidence) await rm(root, { recursive: true, force: true });
    },
    get bootCount() { return boots; },
  };
  try {
    await mkdir(repo);
    await writeFile(path.join(repo, ".remote-agent.config.json"), "{}\n");
    await writeFile(refuseProvider, "throw new Error('Synthetic provider must be explicitly configured by this test');\n");
    const config = parseServiceFile({
      schemaVersion: 2, serviceName: "isolated-workflow-test",
      machine: { id: "isolated-workflow", name: "Isolated workflow test",
        server: { publicUrl: url, apiKey: token, listen: { host: "127.0.0.1", port }, databaseUrl: db.databaseUrl,
          acpSocketPath: path.join(root, "acp.sock"), controlSocketPath: controlSocket },
        acpx: { stateDir: path.join(root, "acpx"), maxConcurrentTurns: 1 }, installation: { root: path.join(root, "install") } },
      providers: { codex: { command: [process.execPath, refuseProvider] }, claude: { command: [process.execPath, refuseProvider] } },
      connections: {}, repositories: { fixture: { root: repo, worktreeRoot: path.join(root, "worktrees") } },
    });
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    // Read back the exact persisted configuration before exposing start().
    const saved = parseServiceFile(JSON.parse(await readFile(configFile, "utf8")));
    if (saved.machine.server.databaseUrl !== db.databaseUrl || saved.machine.server.controlSocketPath !== controlSocket)
      throw new Error("Isolated server configuration identity changed");
    return fixture;
  } catch (error) { await fixture.cleanup(); throw error; }
}
