import { expect, test, spyOn } from "bun:test";
import { createTestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../test-support/agent-runtime.ts";
import { createApp } from "../../app.ts";
import { chatgptReviewForSession } from "../../../../lib/chatgpt-review.ts";

test("session preview view retains ownership and links without reading cleanup history", async () => {
  const db = await createTestDatabase(), config = testConfig();
  try {
    const identity = { id: "primary", machineId: config.machine, repositoryId: config.repository.id };
    await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: identity.repositoryId, machineId: identity.machineId,
      primarySessionId: identity.id, branchName: "codex/task", worktreePath: "/task", toolingRoot: "/tooling", toolingRevision: "pin", phase: "working" } });
    await db.prisma.remoteTaskResource.createMany({ data: [
      { id: "preview", taskId: "task", key: "preview", externalId: "preview", kind: "local-http", purpose: "development", state: "ready", metadata: { publicUrl: "https://preview.example.com", chatgptSkill: "drafted-review" } },
      { id: "released", taskId: "task", key: "released", externalId: "released", kind: "local-http", purpose: "review", state: "released", metadata: { private: "not-needed" } },
      { id: "archive", taskId: "task", key: "archive", externalId: "archive", kind: "source", purpose: "development", state: "ready", metadata: { private: "large-proof" } },
    ] });
    const history = spyOn(db.prisma.runtimeMetadataEvent, "findMany").mockImplementation(() => { throw Error("preview must not load history"); });
    try {
      const app = createApp({ config, prisma: db.prisma, agentRuntime: createFakeAgentRuntime(), trustLocal: true });
      const response = await app.request('/api/tasks?view=session-previews');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tasks[0].resources).toHaveLength(1);
      expect(chatgptReviewForSession(identity, body)).toEqual({ taskId: "task", url: "https://preview.example.com", skill: "drafted-review" });
      expect(chatgptReviewForSession({ ...identity, id: "foreign" }, body)).toBeUndefined();
      expect(history).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("large-proof");
    } finally { history.mockRestore(); }
  } finally { await db.cleanup(); }
});
