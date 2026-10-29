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
