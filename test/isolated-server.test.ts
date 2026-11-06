import { expect, test } from "bun:test";
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
