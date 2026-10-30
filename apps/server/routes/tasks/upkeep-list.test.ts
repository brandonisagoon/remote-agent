import { expect, test } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";

test("maintenance pages all tasks despite activity and marks only accepted cleanup for its current primary", async () => {
  const db = await createTestDatabase();
  try {
    const config = testConfig();
    await db.prisma.remoteTask.createMany({ data: Array.from({ length: 205 }, (_, index) => ({ id: `task-${String(index).padStart(3, "0")}`, requestKey: `task-${index}`, repositoryId: config.repository.id, machineId: config.machine, branchName: `codex/task-${index}`, toolingRoot: "/tooling", toolingRevision: "a".repeat(40), phase: index === 150 ? "waiting" : "closed", primarySessionId: index === 150 ? "primary" : null, ...(index === 150 ? { worktreePath: "/task", connectionId: config.activeConnectionId, issueIdentifier: "DRA-150" } : {}) })) });
    await db.prisma.runtimeSession.create({ data: { id: "primary", scopeKey: "primary", agentCommand: "codex", status: "idle", cwd: "/task", role: "primary", repositoryId: config.repository.id, machineId: config.machine } });
    await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: "primary", provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-150", relationship: "handles" } });
    await db.prisma.runtimeMetadataEvent.create({ data: { runtimeSessionId: "primary", action: "completion-contract", source: "owner:task-150", key: "accepted", value: JSON.stringify({ boundary: "merge", verificationRequired: false }) } });
    const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime() });
    const read = async (cursor?: string) => {
      const response = await app.request(`/api/tasks?pagination=id${cursor ? `&cursor=${cursor}` : ""}`, { headers: { authorization: `Bearer ${config.apiKey}` } });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ tasks: Array<{ id: string; finalizationPending: boolean }>; nextCursor: string | null }>;
    };
    const first = await read();
    await db.prisma.remoteTask.update({ where: { id: "task-001" }, data: { recoveryDetail: "new activity must not change pagination" } });
    const second = await read(first.nextCursor!);
    const third = await read(second.nextCursor!);
    expect([first.tasks.length, second.tasks.length, third.tasks.length]).toEqual([100, 100, 5]);
    expect(new Set([...first.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)).size).toBe(205);
    expect(second.tasks.filter((task) => task.finalizationPending).map((task) => task.id)).toEqual(["task-150"]);
    expect(third.nextCursor).toBeNull();
  } finally { await db.cleanup(); }
});
