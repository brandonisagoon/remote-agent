import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedServer } from "../test-support/isolated-server.ts";

test("real isolated server boots, separates activation transport and retains its own database across restart", async () => {
  const server = await isolatedServer();
  let passed = false;
  try {
    await server.start();
    const firstPid = server.pid;
    expect(firstPid).toBeGreaterThan(0);
    const unauthenticated = await fetch(`${server.url}/api/tooling-releases/fixture`);
    expect(unauthenticated.status).toBe(401);
    const selected = await server.request("/api/tooling-releases/fixture");
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ selection: null });
    expect((await server.socketRequest("/api/tooling-releases/fixture", { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(404);
    await server.db.prisma.remoteTask.create({ data: { id: "synthetic-closed", requestKey: "synthetic-closed", repositoryId: "fixture",
      machineId: "isolated-workflow", branchName: "codex/synthetic-closed", toolingRoot: server.root,
      phase: "closed", ownerPaused: true, toolingRevision: "a".repeat(40) } });
    await server.stop();
    await server.start();
    expect(server.pid).not.toBe(firstPid);
    expect(server.bootCount).toBe(2);
    expect((await server.request("/health")).status).toBe(200);
    expect(await server.db.prisma.remoteTask.findUniqueOrThrow({ where: { id: "synthetic-closed" } }))
      .toMatchObject({ phase: "closed", ownerPaused: true, toolingRevision: "a".repeat(40) });
    expect(await server.db.prisma.runtimeSession.count()).toBe(0);
    passed = true;
  } finally { await server.cleanup({ keepEvidence: !passed }); }
}, 100_000);

test("an explicit preload runs in the isolated child on each boot without inheriting session identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "isolated-preload-"));
  const preload = path.join(root, "transport.ts");
  await writeFile(preload, `import { writeFile } from "node:fs/promises";
import path from "node:path";
const config = process.env.REMOTE_AGENT_CONFIG;
if (!config) throw new Error("Missing private config");
await writeFile(path.join(path.dirname(config), "preload.json"), JSON.stringify({
  pid: process.pid, config, session: process.env.REMOTE_AGENT_SESSION_ID ?? null,
  socket: process.env.REMOTE_AGENT_SOCKET ?? null
}), { mode: 0o600 });
`);
  const server = await isolatedServer({ preload });
  let passed = false;
  try {
    for (let boot = 0; boot < 2; boot++) {
      await server.start();
      const marker = JSON.parse(await readFile(path.join(server.root, "preload.json"), "utf8"));
      expect(marker).toEqual({ pid: server.pid, config: server.configFile, session: null, socket: null });
      expect(marker.pid).not.toBe(process.pid);
      expect((await server.request("/health")).status).toBe(200);
      await server.stop();
    }
    passed = true;
  } finally {
    await server.cleanup({ keepEvidence: !passed });
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
