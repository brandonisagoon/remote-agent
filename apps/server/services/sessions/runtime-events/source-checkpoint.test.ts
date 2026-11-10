import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { appendRuntimeLifecycleEvent, beginRuntimeSession } from "../runtime-registry.ts";
import { projectSourceCheckpoint } from "./source-checkpoint.ts";
import type { LinearCredential } from "../../../../../lib/linear-auth.ts";
import type { AgentRuntimeLifecycleEvent } from "../../../../../types/runtime/index.ts";

let db: TestDatabase | undefined;
afterEach(async () => { await db?.cleanup(); });

test("failure reports reconcile one comment after a lost reply and keep the failed turn's error", async () => {
  db = await createTestDatabase();
  const config = testConfig();
  const session = await beginRuntimeSession(db.prisma, { sessionKey: "checkpoint", agent: "codex", cwd: "/tmp/checkpoint", repositoryId: config.activeRepositoryId, machineId: config.machine });
  await db.prisma.runtimeSessionResourceLink.create({ data: { runtimeSessionId: session.id, provider: "linear", connectionId: config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-1", relationship: "handles" } });
  const event = { kind: "turn" as const, id: "turn:failed", requestId: "turn", sessionId: session.id, createdAt: Date.now(), phase: "failed" as const, error: "Original failure" };
  await appendRuntimeLifecycleEvent(db.prisma, event);
  const stored = new Map<string, { id: string; body: string; issue: { id: string } }>();
  let reads = 0;
  const delivery = {
    issue: async () => ({ id: "issue", identifier: "DRA-1", title: "Pilot", description: null, branchName: "codex/pilot", state: { id: "todo", name: "Todo", type: "started" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } }),
    create: async (_auth: LinearCredential, comment: { id?: string; issueId: string; body: string }) => { const id = z.uuidv4().parse(comment.id); stored.set(id, { id, body: comment.body, issue: { id: comment.issueId } }); return null; },
    read: async (_auth: LinearCredential, id: string) => { if (++reads === 1) throw new Error("offline"); return stored.get(id)!; },
  };
  const runtime = createFakeAgentRuntime();
  runtime.output = async () => "A later turn that must never replace the checkpoint";
  await expect(projectSourceCheckpoint(config, db.prisma, runtime, event, delivery)).rejects.toThrow("offline");
  await db.prisma.$disconnect();
  expect(await projectSourceCheckpoint(config, db.prisma, runtime, event, delivery)).toBe(true);
  expect(stored.size).toBe(1);
  expect([...stored.values()][0]!.body).toContain("Original failure");
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
    issue: async () => ({ id: "issue", identifier: "DRA-1", title: "Pilot", description: null, branchName: "codex/pilot", state: { id: "todo", name: "Todo", type: "started" }, team: { states: { nodes: [] } }, labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } }),
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

test("RA-25: completed turns and changed acknowledgments produce no comments and retain their journal", async () => {
  const f = await fixture();
  const first = await f.event();
  await f.project(first);
  await f.prisma.$disconnect();
  await f.project(first);
  await f.project(await f.event({ output: `\n${first.output}\n` }));
  const changed = await f.event({ output: "Review is ready at https://example.test/preview; approve the deployment when ready." });
  await f.project(changed);
  await f.project(first); // an older journal event cannot rewind the checkpoint
  expect(f.comments).toHaveLength(0);
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
  await f.project(await f.event({ phase: "failed", error: "First failure" }));
  expect(f.comments[0]!.parentId).toBeUndefined();
  await f.project(await f.event({ phase: "failed", error: "Changed failure" }));
  expect(f.comments).toHaveLength(1); // Rewording the same failure is internal.
});

test("failures remain visible while completed acknowledgments stay internal", async () => {
  const f = await fixture();
  const completed = await f.event();
  await f.project(completed);
  const failed = await f.event({ phase: "failed", error: "Worker exited unexpectedly" });
  await f.project(failed);
  await f.project(await f.event({ requestId: failed.requestId, phase: "failed", error: failed.error }));
  await f.project(await f.event({ phase: "failed", error: failed.error }));
  await f.project(await f.event({ output: completed.output }));
  await f.project(await f.event({ phase: "failed", error: "   " }));
  expect(f.comments).toHaveLength(3);
  expect(f.comments[0]!.body).toContain("### Agent turn failed\n\nWorker exited unexpectedly");
  expect(f.comments[1]!.body).toContain("Earlier blocker resolved");
  expect(f.comments[2]!.body).toContain("The agent turn failed.");
});

test("long failure output stays bounded and changed diagnostics stay in the journal without duplicate updates", async () => {
  const f = await fixture();
  const output = "Opening context\n" + "a".repeat(3000) + "first diagnostic" + "z".repeat(3000) + "\nFinal result and owner action";
  const first = await f.event({ phase: "failed", error: output });
  await f.project(first);
  await f.project(await f.event({ phase: "failed", error: output.replace("first diagnostic", "new diagnostic") }));
  expect(f.comments).toHaveLength(1);
  expect(f.comments[0]!.body.length).toBeLessThan(2300);
  expect(f.comments[0]!.body).toContain("Opening context");
  expect(f.comments[0]!.body).toContain("Final result and owner action");
  expect(f.comments[0]!.body).toContain("excerpt shortened");
  expect(f.comments[0]!.body).toContain("runtime lifecycle journal");
  expect((await f.prisma.runtimeLifecycleEvent.findUniqueOrThrow({ where: { id: first.id } })).error).toBe(output);
  const failure = await f.event({ phase: "failed", error: output });
  await f.project(failure);
  expect(f.comments[0]!.body).toContain("### Agent turn failed");
  expect((await f.prisma.runtimeLifecycleEvent.findUniqueOrThrow({ where: { id: failure.id } })).error).toBe(output);
});


test("explicit results and pending publications never cause automatic acknowledgments", async () => {
  const f = await fixture();
  for (const commentPosted of [false, true]) {
    await f.prisma.runtimeIssueUpdate.create({ data: {
      runtimeSessionId: f.session.id, requestKey: `explicit:${commentPosted}`, connectionId: f.config.activeConnectionId,
      issueId: "issue", input: { body: "Actual result" }, evidence: [], commentPosted,
    } });
    await f.project(await f.event({ output: "I posted the result. Now waiting for review." }));
    await f.prisma.$disconnect();
    await f.project(await f.event({ output: "Still waiting for review." }));
  }
  expect(f.comments).toHaveLength(0);
  await f.project(await f.event({ phase: "failed", error: "Primary process exited" }));
  expect(f.comments).toHaveLength(1);
  expect(await f.prisma.runtimeIssueUpdate.count()).toBe(3);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(5);
});

test("a failed publication leaves the checkpoint retryable and unrelated session work available", async () => {
  const f = await fixture();
  const event = await f.event({ phase: "failed", error: "Failed operation" });
  await expect(projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery, create: async () => { throw new Error("offline"); },
  })).rejects.toThrow("offline");
  expect(await f.prisma.runtimeEventCursor.count({ where: { consumer: { startsWith: "linear-source-checkpoint:" } } })).toBe(0);
  // Projection has no execution/lifecycle mutation; diagnostics remain durable.
  expect((await f.prisma.runtimeSession.findUniqueOrThrow({ where: { id: f.session.id } })).status).not.toBe("closed");
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(1);
  await f.project(event);
  expect(f.comments).toHaveLength(1);
});

test("a pending pre-upgrade comment reconciles the same UUID without rewriting its legacy body", async () => {
  const f = await fixture();
  const output = "Long diagnostic\n" + "x".repeat(9000) + "\nResult";
  const event = await f.event({ phase: "failed", error: output });
  const digest = createHash("sha256").update(`linear-checkpoint:${event.sessionId}:${event.id}`).digest("hex");
  const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const legacyBody = `### Agent turn failed\n\n…${output.slice(-8000)}`;
  await projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery,
    create: async () => { throw new Error("Legacy comment must not be posted again"); },
    read: async (_auth, asked) => asked === id ? ({ id, body: legacyBody, issue: { id: "issue" } }) : null,
  });
  await f.project(event);
  expect(f.comments).toHaveLength(0);
  expect(await f.prisma.runtimeSessionResourceLink.count({ where: { resourceType: "comment-thread", externalId: id } })).toBe(1);
});

test("unconfirmed comment identity never advances the duplicate-suppression cursor", async () => {
  const f = await fixture();
  const event = await f.event({ phase: "failed", error: "Failed operation" });
  let id = "";
  await expect(projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery,
    create: async (_auth, comment) => { id = comment.id!; return null; },
    read: async () => ({ id, body: `### Agent turn failed\n\n${event.error}`, issue: { id: "another-issue" } }),
  })).rejects.toThrow("delivery unconfirmed");
  expect(await f.prisma.runtimeEventCursor.count({ where: { consumer: { startsWith: "linear-source-checkpoint:" } } })).toBe(0);
  await f.project(event);
  expect(f.comments).toHaveLength(1);
});


test("pre-upgrade completed events never replay historical checkpoint comments", async () => {
  const f = await fixture();
  const event = await f.event({ createdAt: Date.now() - 86_400_000, output: "Old checkpoint" });
  await f.project(event);
  await f.prisma.$disconnect();
  await f.project(event);
  expect(f.comments).toHaveLength(0);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(1);
});


test("RA-25: replay observes a recorded recovery before a later identical failure", async () => {
  const f = await fixture();
  await f.project(await f.event({ phase: "failed", error: "Same failure" }));
  const recovery = await f.event({ phase: "completed", output: "Recovered" });
  const recurrence = await f.event({ phase: "failed", error: "Same failure" });
  await f.prisma.$disconnect();
  await f.project(recovery); await f.project(recurrence); await f.project(recurrence);
  expect(f.comments).toHaveLength(3);
  expect(f.comments[1]!.body).toContain("Earlier blocker resolved");
  expect(f.comments[2]!.body).toContain("Same failure");
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(3);
});

test("RA-25: delegates keep routine failures in the journal and primary inbox", async () => {
  const f = await fixture();
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { role: "delegate" } });
  await f.project(await f.event({ phase: "failed", error: "Worker failed" }));
  expect(f.comments).toHaveLength(0);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(1);
});

test("RA-25: retained mirror reconciles its old thread child rather than posting another failure", async () => {
  const f = await fixture();
  const mirror = await f.prisma.sessionMirror.create({ data: { sessionKey: "old-mirror", connectionId: f.config.activeConnectionId, externalId: "agent-issue", rootCommentId: "old-root" } });
  await f.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { sessionMirrorId: mirror.id } });
  const event = await f.event({ phase: "failed", error: "Old mirror failure", createdAt: Date.now() - 10000 });
  const body = "❌ Agent turn failed\n\nOld mirror failure";
  await projectSourceCheckpoint(f.config, f.prisma, f.runtime, event, {
    ...f.delivery, create: async () => { throw new Error("Old failure must not post again"); },
    read: async (_auth, id) => id === "old-root" ? { id, body: "Remote Agent session", issue: { id: "issue" } } : null,
    timeline: async () => [{ id: "old-failure", parentId: "old-root", body, createdAt: new Date(Date.now() - 5000).toISOString() }],
  });
  await f.project(event);
  expect(f.comments).toHaveLength(0);
  const receipt = await f.prisma.runtimeIssueUpdate.findUniqueOrThrow({ where: { id: "old-failure" } });
  expect(receipt.published).toBe(true);
  expect((receipt.input as { body: string }).body).toBe(body);
  expect(await f.prisma.runtimeLifecycleEvent.count()).toBe(1);
});
