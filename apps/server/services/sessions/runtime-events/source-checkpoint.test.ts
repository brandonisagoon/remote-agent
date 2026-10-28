import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { appendRuntimeLifecycleEvent, beginRuntimeSession } from "../runtime-registry.ts";
import { projectSourceCheckpoint } from "./source-checkpoint.ts";
import type { LinearCredential } from "../../../../../lib/linear-auth.ts";
import type { AgentRuntimeLifecycleEvent } from "../../../../../types/runtime/index.ts";

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

async function fixture() {
  db = await createTestDatabase();
  const prisma = db.prisma;
  const config = testConfig();
  const session = await beginRuntimeSession(prisma, { sessionKey: "checkpoints", agent: "codex", cwd: "/tmp/checkpoints", repositoryId: config.activeRepositoryId, machineId: config.machine });
  await prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-1", relationship: "handles" } });
  const comments: { id: string; body: string; parentId?: string }[] = [];
  const delivery = {
    issue: async () => ({ id: "issue", identifier: "DRA-1", title: "Pilot", description: null, branchName: "codex/pilot", state: { name: "Todo" }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } }),
    create: async (_auth: LinearCredential, comment: { id?: string; issueId: string; body: string; parentId?: string }) => {
      const id = z.uuidv4().parse(comment.id);
      comments.push({ ...comment, id });
      return { id };
    },
    read: async (_auth: LinearCredential, id: string) => {
      const comment = comments.find((item) => item.id === id);
      return comment ? { ...comment, issue: { id: "issue" } } : null;
    },
  };
  const runtime = createFakeAgentRuntime();
  let number = 0;
  const event = async (input: Partial<AgentRuntimeLifecycleEvent> = {}) => {
    number++;
    return appendRuntimeLifecycleEvent(prisma, {
      kind: "turn", id: `event-${number}`, requestId: `request-${number}`, sessionId: session.id,
      createdAt: Date.now(), phase: "completed", output: "Tests pass; implementation is ready for review.", ...input,
    });
  };
  const project = (input: AgentRuntimeLifecycleEvent) => projectSourceCheckpoint(config, prisma, runtime, input, delivery);
  return { prisma, config, session, runtime, comments, delivery, event, project };
}

test("durable checkpoint cursor suppresses replay and consecutive identical successes, but retains changed results", async () => {
  const f = await fixture();
  const first = await f.event();
  await f.project(first);
  await f.prisma.$disconnect();
  await f.project(first);
  await f.project(await f.event({ output: `\n${first.output}\n` }));
  const changed = await f.event({ output: "Review is ready at https://example.test/preview; approve the deployment when ready." });
  await f.project(changed);
  await f.project(first); // an older journal event cannot rewind the checkpoint
  expect(f.comments).toHaveLength(2);
  expect(f.comments[1]!.body).toContain(changed.output!);
  expect(f.comments[1]!.parentId).toBe(f.comments[0]!.id);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(3);
});

test("source checkpoints never attach to an owned child issue thread", async () => {
  const f = await fixture();
  await f.prisma.runtimeSessionResourceLink.create({ data: {
    runtimeSessionId: f.session.id, provider: "linear", connectionId: f.config.activeConnectionId,
    resourceType: "comment-thread", externalId: "child-comment", relationship: "thread",
  } });
  const read = f.delivery.read;
  f.delivery.read = async (auth, id) => id === "child-comment"
    ? { id, body: "Child update", issue: { id: "different-child" } }
    : read(auth, id);
  await f.project(await f.event());
  expect(f.comments[0]!.parentId).toBeUndefined();
  await f.project(await f.event({ output: "Changed result" }));
  expect(f.comments[1]!.parentId).toBe(f.comments[0]!.id);
});

test("failures remain visible for distinct requests and reset success deduplication", async () => {
  const f = await fixture();
  const completed = await f.event();
  await f.project(completed);
  const failed = await f.event({ phase: "failed", error: "Worker exited unexpectedly" });
  await f.project(failed);
  await f.project(await f.event({ requestId: failed.requestId, phase: "failed", error: failed.error }));
  await f.project(await f.event({ phase: "failed", error: failed.error }));
  await f.project(await f.event({ output: completed.output }));
  await f.project(await f.event({ phase: "failed", error: "   " }));
  expect(f.comments).toHaveLength(5);
  expect(f.comments[1]!.body).toContain("### Agent turn failed\n\nWorker exited unexpectedly");
  expect(f.comments[2]!.body).toContain("Worker exited unexpectedly");
  expect(f.comments[3]!.body).toContain(completed.output!);
  expect(f.comments[4]!.body).toContain("The agent turn failed.");
});

test("long output is an honest bounded excerpt while full diagnostics and middle-only changes survive", async () => {
  const f = await fixture();
  const output = "Opening context\n" + "a".repeat(3000) + "first diagnostic" + "z".repeat(3000) + "\nFinal result and owner action";
  const first = await f.event({ output });
  await f.project(first);
  await f.project(await f.event({ output: output.replace("first diagnostic", "new diagnostic") }));
  expect(f.comments).toHaveLength(2);
  expect(f.comments[0]!.body.length).toBeLessThan(2300);
  expect(f.comments[0]!.body).toContain("Opening context");
  expect(f.comments[0]!.body).toContain("Final result and owner action");
  expect(f.comments[0]!.body).toContain("excerpt shortened");
  expect(f.comments[0]!.body).toContain("runtime lifecycle journal");
  expect((await f.prisma.runtimeLifecycleEvent.findUniqueOrThrow({ where: { id: first.id } })).output).toBe(output);
  const failure = await f.event({ phase: "failed", error: output });
  await f.project(failure);
  expect(f.comments[2]!.body).toContain("### Agent turn failed");
  expect((await f.prisma.runtimeLifecycleEvent.findUniqueOrThrow({ where: { id: failure.id } })).error).toBe(output);
});

test("only the latest confirmed explicit comment in the same turn suppresses an exact automatic duplicate", async () => {
  const f = await fixture();
  const startedAt = new Date(Date.now() - 10_000);
  const postedAt = new Date(startedAt.getTime() + 1000);
  const output = "Review ready. Please check the preview and approve.";
  await f.event({ phase: "started", requestId: "explicit", createdAt: startedAt.getTime() });
  const receipt = await f.prisma.runtimeIssueUpdate.create({ data: {
    runtimeSessionId: f.session.id, requestKey: "review", connectionId: f.config.activeConnectionId,
    issueId: "issue", input: { body: output }, evidence: [], commentPosted: true, published: false,
    createdAt: postedAt, updatedAt: postedAt,
  } });
  await f.project(await f.event({ requestId: "explicit", output }));
  expect(f.comments).toHaveLength(0);
  // A failure after the comment is never hidden by that successful delivery.
  await f.project(await f.event({ requestId: "explicit", phase: "failed", error: output }));
  expect(f.comments).toHaveLength(1);
  // A different turn cannot reuse the old explicit comment as proof of delivery.
  await f.event({ phase: "started", requestId: "later", createdAt: postedAt.getTime() + 1000 });
  await f.project(await f.event({ requestId: "later", output }));
  expect(f.comments).toHaveLength(2);
  // A pending/uncertain receipt also cannot replace a checkpoint.
  await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { commentPosted: false, updatedAt: postedAt } });
  const pendingOutput = "An additional result must still be posted.";
  await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { input: { body: pendingOutput }, updatedAt: postedAt } });
  await f.project(await f.event({ requestId: "explicit", output: pendingOutput }));
  expect(f.comments).toHaveLength(3);
});

test("explicit receipt timing must precede the terminal event and a newer comment wins over an earlier match", async () => {
  const f = await fixture();
  const startedAt = new Date(Date.now() - 10_000);
  const endedAt = new Date(startedAt.getTime() + 2000);
  await f.event({ phase: "started", requestId: "timing", createdAt: startedAt.getTime() });
  const output = "Result A";
  const receipt = await f.prisma.runtimeIssueUpdate.create({ data: {
    runtimeSessionId: f.session.id, requestKey: "late", connectionId: f.config.activeConnectionId,
    issueId: "issue", input: { body: output }, evidence: [], commentPosted: true,
    createdAt: startedAt, updatedAt: new Date(endedAt.getTime() + 1),
  } });
  await f.project(await f.event({ requestId: "timing", output, createdAt: endedAt.getTime() }));
  expect(f.comments).toHaveLength(1);
  await f.prisma.runtimeIssueUpdate.update({ where: { id: receipt.id }, data: { updatedAt: endedAt } });
  await f.prisma.runtimeIssueUpdate.create({ data: {
    runtimeSessionId: f.session.id, requestKey: "newer", connectionId: f.config.activeConnectionId,
    issueId: "issue", input: { body: "A newer explicit result" }, evidence: [], commentPosted: true,
    createdAt: new Date(startedAt.getTime() + 1), updatedAt: endedAt,
  } });
  await f.project(await f.event({ phase: "failed", error: "Retrying" }));
  await f.project(await f.event({ requestId: "timing", output, createdAt: endedAt.getTime() }));
  expect(f.comments).toHaveLength(3);
});

test("a failed publication leaves the checkpoint retryable and unrelated session work available", async () => {
  const f = await fixture();
  const event = await f.event();
  await expect(projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery, create: async () => { throw new Error("offline"); },
  })).rejects.toThrow("offline");
  expect(await f.prisma.runtimeEventCursor.count()).toBe(0);
  // Projection has no execution/lifecycle mutation; diagnostics remain durable.
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).not.toBe("closed");
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(1);
  await f.project(event);
  expect(f.comments).toHaveLength(1);
});

test("a pending pre-upgrade comment reconciles the same UUID without rewriting its legacy body", async () => {
  const f = await fixture();
  const output = "Long diagnostic\n" + "x".repeat(9000) + "\nResult";
  const event = await f.event({ output });
  let id = "";
  const legacyBody = `### Agent checkpoint\n\n…${output.slice(-8000)}`;
  await projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery,
    create: async (_auth, comment) => { id = comment.id!; return null; },
    read: async () => ({ id, body: legacyBody, issue: { id: "issue" } }),
  });
  await f.project(event);
  expect(f.comments).toHaveLength(0);
  expect(await f.prisma.runtimeSessionResourceLink.count({ where: { resourceType: "comment-thread", externalId: id } })).toBe(1);
});

test("unconfirmed comment identity never advances the duplicate-suppression cursor", async () => {
  const f = await fixture();
  const event = await f.event();
  let id = "";
  await expect(projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery,
    create: async (_auth, comment) => { id = comment.id!; return null; },
    read: async () => ({ id, body: `### Agent checkpoint\n\n${event.output}`, issue: { id: "another-issue" } }),
  })).rejects.toThrow("delivery unconfirmed");
  expect(await f.prisma.runtimeEventCursor.count()).toBe(0);
  await f.project(event);
  expect(f.comments).toHaveLength(1);
});
