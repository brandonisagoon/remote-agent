import { expect, test } from "bun:test";
import { z } from "zod";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";

// Released Drafted pins require these fields before any lifecycle command.
const LegacyTask = z.object({ id: z.string(), primarySessionId: z.string().nullable(), worktreePath: z.string(), toolingRevision: z.string(), controlMode: z.string(), controllerId: z.string().nullable(), resources: z.array(z.unknown()).default([]) });

test("task reads preserve old pinned clients without restoring browser state or takeover", async () => {
  const db = await createTestDatabase();
  try {
    const config = testConfig();
    const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const task = await db.prisma.remoteTask.create({ data: { id: "legacy-task", requestKey: "legacy-task", repositoryId: config.repository.id, machineId: config.machine, branchName: "codex/task", primarySessionId: "primary", worktreePath: "/legacy-task", toolingRoot: "/tooling", toolingRevision: "old-pin" } });
    for (const state of [{ phase: "working", ownerPaused: false }, { phase: "review", ownerPaused: true }, { phase: "closed", ownerPaused: false }]) {
      await db.prisma.remoteTask.update({ where: { id: task.id }, data: state });
      for (const route of [`/api/tasks/${task.id}`, "/api/sessions/primary/task", "/api/tasks", "/api/tasks?pagination=id"]) {
        const response = await app.request(route);
        expect(response.status).toBe(200);
        const data = await response.json() as { task?: unknown; tasks?: unknown[] };
        const legacy = LegacyTask.parse(data.task ?? data.tasks?.[0]);
        expect(legacy).toMatchObject({ id: task.id, primarySessionId: "primary", toolingRevision: "old-pin", worktreePath: "/legacy-task", controlMode: state.ownerPaused || state.phase === "closed" ? "paused" : "agent", controllerId: state.ownerPaused || state.phase === "closed" ? `task-supervisor:${task.id}` : null });
      }
    }
    expect((await app.request(`/api/tasks/${task.id}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "take", controllerId: "old-browser-viewer" }) })).status).toBe(404);
    const stored = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } });
    expect("controlMode" in stored).toBeFalse();
    expect("controllerId" in stored).toBeFalse();
  } finally { await db.cleanup(); }
});

test("every task read exposes v2 negotiation after adoption without inventing confirmed retention", async () => {
  const db = await createTestDatabase();
  try {
    const config = testConfig();
    const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
    const session = await db.prisma.runtimeSession.create({ data: { id: "external-primary", scopeKey: "external-primary", agentCommand: "codex", role: "primary", status: "closed", cwd: "/original-product", repositoryId: config.repository.id, machineId: config.machine } });
    const task = await db.prisma.remoteTask.create({ data: { id: "external-task", requestKey: "external-task", repositoryId: config.repository.id, machineId: config.machine, branchName: "codex/original", primarySessionId: session.id, worktreePath: session.cwd, toolingRoot: "/original-tooling", toolingRevision: "original-pin", phase: "closed" } });
    // Protocol negotiation is conservative even if an incomplete historical
    // record needs repair; it must never grant retained-resource exemptions.
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: session.id, source: `owner:${task.id}`, action: "external-delivery-binding", key: "adoption", value: "{}" } });
    for (const route of [`/api/tasks/${task.id}`, `/api/sessions/${session.id}/task`, "/api/tasks", "/api/tasks?pagination=id"]) {
      const response = await app.request(route);
      expect(response.status).toBe(200);
      const data = await response.json() as { task?: Record<string, unknown>; tasks?: Array<Record<string, unknown>> };
      const observed = data.task ?? data.tasks?.[0];
      expect(observed).toMatchObject({ id: task.id, finalizationVersion: 2, toolingRevision: "original-pin", controlMode: "paused" });
      expect(observed).not.toHaveProperty("finalizationRetention");
    }
  } finally { await db.cleanup(); }
});
