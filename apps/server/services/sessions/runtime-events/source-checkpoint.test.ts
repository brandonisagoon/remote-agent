import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession } from "../runtime-registry.ts";
import { projectSourceCheckpoint } from "./source-checkpoint.ts";
import type { LinearCredential } from "../../../../../lib/linear-auth.ts";

let db: TestDatabase | undefined;
afterEach(async () => { await db?.cleanup(); });

test("source checkpoints reconcile one comment after a lost reply and keep the completed turn's output", async () => {
  db = await createTestDatabase();
  const config = testConfig();
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "checkpoint", agent: "codex", cwd: "/tmp/checkpoint", repositoryId: config.activeRepositoryId, machineId: config.machine });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-1", relationship: "handles" } });
  const event = { kind: "turn" as const, id: "turn:completed", requestId: "turn", sessionId: session.id, createdAt: Date.now(), phase: "completed" as const, output: "Original completed output" };
  const stored = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let reads = 0;
  const delivery = {
    issue: async () => ({ id: "issue", identifier: "DRA-1", title: "Pilot", description: null, branchName: "codex/pilot", state: { name: "Todo" }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } }),
    create: async (_auth: LinearCredential, comment: { id?: string; issueId: string; body: string }) => { const id = z.uuidv4().parse(comment.id); stored.set(id, { id, body: comment.body, issue: { id: comment.issueId } }); return null; },
    read: async (_auth: LinearCredential, id: string) => { if (++reads === 1) throw new Error("offline"); return stored.get(id)!; },
  };
  const runtime = createFakeAgentRuntime();
  runtime.output = async () => "A later turn that must never replace the checkpoint";
  await expect(projectSourceCheckpoint(config, db.prisma, runtime, event, delivery)).rejects.toThrow("offline");
  await db.prisma.$disconnect();
  expect(await projectSourceCheckpoint(config, db.prisma, runtime, event, delivery)).toBe(true);
  expect(stored.size).toBe(1);
  expect([...stored.values()][0]!.body).toContain("Original completed output");
  expect(await db.prisma.runtimeSessionResourceLink.count({ where: { resourceType: "comment-thread" } })).toBe(1);
});
