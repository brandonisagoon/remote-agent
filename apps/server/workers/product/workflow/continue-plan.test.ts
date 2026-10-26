import { afterEach, expect, test } from "bun:test";
import { createTestDatabase, type TestDatabase } from "../../../../../test-support/db.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { beginRuntimeSession, findRuntimeSession } from "../../../services/sessions/runtime-registry.ts";
import { beginTask } from "../../../services/tasks/store.ts";
import { deliverInstructions, queueInstruction } from "../../../services/sessions/inbox.ts";
import type { WorkerContext } from "../../../../../types/dispatcher/index.ts";
import type { WorkflowConfig } from "../../../../../lib/config.ts";
import { continuePlanningSession } from "./continue-plan.ts";
import { createWorkflowWorker } from "./worker.ts";
import { DispatchEventType } from "../../../../../types/dispatcher/index.ts";

let db: TestDatabase;
afterEach(async () => { await db?.cleanup(); });

async function fixture() {
  db = await createTestDatabase();
  const config = testConfig();
  const plan: WorkflowConfig = { ...config.repository.workflows.plan!, providerId: "claude", plan: { captureToIssue: true, thenState: null } };
  const workflow: WorkflowConfig = { ...plan, id: "implement", providerId: "codex", model: "gpt-6-astra", plan: null };
  config.repository = { ...config.repository, tooling: { root: "/tooling", revision: "new-tooling" }, workflows: { plan, implement: workflow } };
  config.repositories = { ...config.repositories, [config.repository.id]: config.repository };
  const session = await beginRuntimeSession(db.prisma, {
    sessionKey: "plan", agent: "claude", cwd: "/worktrees/issue", repositoryId: config.repository.id,
    machineId: config.machine, role: "primary", lifecycle: "persistent", workflowId: "plan",
    resourceLinks: [{ provider: "linear", connectionId: config.activeConnectionId,
      resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" }],
  });
  await db.prisma.runtimeSession.update({ where: { id: session.id }, data: { status: "idle", acpxRecordId: "original-plan-record" } });
  const task = await beginTask(db.prisma, { requestKey: "original-launch", repository: config.repository,
    machineId: config.machine, connectionId: config.activeConnectionId, issueIdentifier: "DRA-8", branchName: "codex/dra-8" });
  const originalTask = await db.prisma.remoteTask.update({ where: { id: task.id }, data: {
    worktreePath: session.cwd, primarySessionId: session.id, phase: "waiting", baseCommit: "original-base",
    toolingRevision: "original-tooling", pinnedToolingRoot: "/pinned/original-tooling",
  } });
  const runtime = createFakeAgentRuntime();
  const calls: string[] = [];
  const compositions: unknown[][] = [];
  runtime.getSession = async (id) => {
    const value = await findRuntimeSession(db.prisma, id);
    return value && { ...value, configOptions: [{ id: "model", category: "model", type: "select", name: "Model", currentValue: "default", options: [] }] };
  };
  runtime.switchAgent = async (id, agent) => {
    calls.push(`provider:${agent}`);
    await db.prisma.runtimeSession.update({ where: { id }, data: { agentCommand: agent } });
    return (await runtime.getSession(id))!;
  };
  runtime.setConfigOption = async (_id, key, value) => {
    calls.push(`${key}:${value}`);
    return [{ id: key, category: "model", type: "select", name: "Model", currentValue: value, options: [] }];
  };
  runtime.setMode = async (_id, mode) => { calls.push(`mode:${mode}`); };
  const context: WorkerContext = { prisma: db.prisma, config, agentRuntime: runtime, runId: "rocket-run", commandClient: {
    run: async () => { throw new Error("Continuation must not run git or provision another worktree"); },
  } as WorkerContext["commandClient"] };
  const input = { context, workflow, issueIdentifier: "DRA-8", seed: "Implement the issue and its published plan", compose: async (...args: Parameters<NonNullable<Parameters<typeof continuePlanningSession>[0]["compose"]>>) => {
    compositions.push(args);
    return `composed:${args[1]}`;
  } };
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      if (!(await db.prisma.runtimeInstruction.count({ where: { state: { in: ["queued", "dispatching"] } } }))) return;
      await Bun.sleep(5);
    }
  };
  return { input, runtime, calls, compositions, session, originalTask, settle };
}

test("rocket continues the planned primary on Astra, preserving task, worktree and pins", async () => {
  const f = await fixture();
  let reactions = 0;
  const worker = createWorkflowWorker({
    getIssue: async () => ({ id: "issue", identifier: "DRA-8", title: "Fix lot", description: "Original screenshot\n## Implementation Plan\nFix stacking", state: { name: "Todo" } }) as never,
    react: async () => { reactions++; return true; },
    postWorktreeComment: async () => { throw new Error("Existing thread must stay bound"); },
    compose: f.input.compose,
    launch: async () => { throw new Error("Must not launch a replacement session"); },
  });
  const result = await worker.execute({ type: DispatchEventType.TrackerWorkflowTriggered, workflowId: "implement",
    webhook: { type: "Reaction", action: "create", webhookTimestamp: Date.now(), data: { id: "reaction", emoji: "rocket", issueId: "issue", issue: { id: "issue", identifier: "DRA-8" } } },
  } as never, f.input.context);
  await f.settle();
  expect(result.status).toBe("delivered");
  expect(reactions).toBe(1);
  expect(f.calls).toEqual(["provider:codex", "model:gpt-6-astra"]);
  expect(f.compositions[0]?.[0]).toBe(f.originalTask.worktreePath);
  expect(f.compositions[0]?.[2]).toBe("codex");
  expect(f.compositions[0]?.[4]).toBe(f.originalTask.pinnedToolingRoot);
  const current = await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: f.originalTask.id } });
  for (const key of ["id", "requestKey", "primarySessionId", "baseCommit", "branchName", "worktreePath", "toolingRoot", "toolingRevision", "pinnedToolingRoot"] as const) expect(current[key]).toBe(f.originalTask[key]);
  expect(await db.prisma.runtimeSession.count()).toBe(1);
  expect(await db.prisma.runtimeSession.findUnique({ where: { id: f.session.id } })).toMatchObject({ workflowId: "implement", agentCommand: "codex" });
  expect(f.runtime.sentMessages).toHaveLength(1);
  expect(f.runtime.sentMessages[0]?.sessionId).toBe(f.session.id);
  expect(f.runtime.sentMessages[0]?.text).toContain("## Implementation Plan");
  expect(f.runtime.sentMessages[0]?.text).toContain("no longer a planning-only turn");
  expect((await db.prisma.runtimeMetadataEvent.findFirst())?.value).toContain("original-plan-record");
});

test("a same-provider continuation exits plan mode and selects the execution model", async () => {
  const f = await fixture();
  f.input.workflow.providerId = "claude";
  f.input.workflow.model = "opus";
  expect((await continuePlanningSession(f.input))?.status).toBe("delivered");
  await f.settle();
  expect(f.calls).toEqual(["provider:claude", "model:opus", "mode:default"]);
});

test("concurrent and later reactions produce one execution instruction", async () => {
  const f = await fixture();
  const outcomes = await Promise.all([continuePlanningSession(f.input), continuePlanningSession(f.input)]);
  await f.settle();
  expect(outcomes.filter((r) => r?.status === "delivered")).toHaveLength(1);
  expect(await continuePlanningSession(f.input)).toBeNull();
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(f.runtime.sentMessages).toHaveLength(1);
});

test.each(["active", "provisioning", "error"])("does not switch a %s primary", async (status) => {
  const f = await fixture();
  await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: { status } });
  expect((await continuePlanningSession(f.input))?.status).toBe("failed");
  expect(f.calls).toHaveLength(0);
  expect(await db.prisma.runtimeInstruction.count()).toBe(0);
});

test.each(["queued", "dispatching", "unknown"])("does not overtake a %s instruction", async (state) => {
  const f = await fixture();
  await db.prisma.runtimeInstruction.create({ data: { id: "earlier", sessionId: f.session.id, text: "Owner feedback", state } });
  expect((await continuePlanningSession(f.input))?.status).toBe("failed");
  expect(f.calls).toHaveLength(0);
  expect(f.runtime.sentMessages).toHaveLength(0);
});

test.each(["paused", "human", "draining"])("does not override %s task control", async (controlMode) => {
  const f = await fixture();
  await db.prisma.remoteTask.update({ where: { id: f.originalTask.id }, data: { controlMode } });
  expect((await continuePlanningSession(f.input))?.status).toBe("failed");
  expect(f.calls).toHaveLength(0);
});

test("provider failure does not commit execution; a verified retry reuses its instruction", async () => {
  const f = await fixture();
  const switchAgent = f.runtime.switchAgent;
  f.runtime.switchAgent = async () => { throw new Error("Provider unavailable"); };
  expect((await continuePlanningSession(f.input))?.status).toBe("failed");
  expect((await db.prisma.runtimeSession.findUnique({ where: { id: f.session.id } }))?.workflowId).toBe("plan");
  expect((await db.prisma.runtimeInstruction.findFirst())?.state).toBe("preparation-failed");
  expect(f.runtime.sentMessages).toHaveLength(0);
  f.runtime.switchAgent = switchAgent;
  expect((await continuePlanningSession(f.input))?.status).toBe("delivered");
  await f.settle();
  expect(await db.prisma.runtimeInstruction.count()).toBe(1);
  expect(f.runtime.sentMessages).toHaveLength(1);
  expect(f.compositions).toHaveLength(1);
});

test("task control changing during preparation prevents execution", async () => {
  const f = await fixture();
  const setModel = f.runtime.setConfigOption;
  f.runtime.setConfigOption = async (...args) => {
    await db.prisma.remoteTask.update({ where: { id: f.originalTask.id }, data: { controlMode: "human", controlGeneration: { increment: 1 } } });
    return setModel(...args);
  };
  expect((await continuePlanningSession(f.input))?.status).toBe("failed");
  expect(f.runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeSession.findUnique({ where: { id: f.session.id } }))?.workflowId).toBe("plan");
});

test("a model rejected by the provider never starts the default model", async () => {
  const f = await fixture();
  f.runtime.setConfigOption = async () => [];
  const result = await continuePlanningSession(f.input);
  expect(result?.status).toBe("failed");
  expect(result?.detail).toContain("did not accept workflow model");
  expect(f.runtime.sentMessages).toHaveLength(0);
});

test("inbox holds owner follow-ups while a workflow is preparing", async () => {
  const f = await fixture();
  await db.prisma.runtimeInstruction.create({ data: { id: "handoff", sessionId: f.session.id, text: "Implement", state: "preparing" } });
  await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "followup", text: "Owner feedback" });
  await deliverInstructions(db.prisma, f.runtime);
  expect(f.runtime.sentMessages).toHaveLength(0);
  expect((await db.prisma.runtimeInstruction.findUnique({ where: { id: "followup" } }))?.state).toBe("queued");
});

test.each(["connection", "repository", "role", "closed"])("does not reuse a planning session from another scope: %s", async (kind) => {
  const f = await fixture();
  if (kind === "connection") await db.prisma.runtimeSessionResourceLink.updateMany({ data: { connectionId: "unrelated-workspace" } });
  else await db.prisma.runtimeSession.update({ where: { id: f.session.id }, data: kind === "repository" ? { repositoryId: "other" } : kind === "role" ? { role: "delegate" } : { status: "closed" } });
  expect(await continuePlanningSession(f.input)).toBeNull();
  expect(f.calls).toHaveLength(0);
});

test("multiple primaries cannot be resolved by arbitrarily picking one", async () => {
  const f = await fixture();
  await beginRuntimeSession(db.prisma, { sessionKey: "other", agent: "codex", cwd: "/other-worktree",
    repositoryId: f.input.context.config.repository.id, machineId: f.input.context.config.machine, role: "primary", lifecycle: "persistent",
    resourceLinks: [{ provider: "linear", connectionId: f.input.context.config.activeConnectionId, resourceType: "issue-identifier", externalId: "DRA-8", relationship: "handles" }],
  });
  expect((await continuePlanningSession(f.input))?.detail).toContain("Multiple primary sessions");
  expect(f.calls).toHaveLength(0);
});

test("unfinished delegate work blocks a provider switch", async () => {
  const f = await fixture();
  const child = await beginRuntimeSession(db.prisma, { sessionKey: "child", agent: "claude", cwd: f.session.cwd,
    repositoryId: f.input.context.config.repository.id, machineId: f.input.context.config.machine, role: "delegate", lifecycle: "persistent" });
  await db.prisma.runtimeSession.update({ where: { id: child.id }, data: { status: "active" } });
  expect((await continuePlanningSession(f.input))?.detail).toContain("Another session is still working");
  expect(f.calls).toHaveLength(0);
});

test("a preparation interrupted before enqueue can be resumed without recomposing or duplicating", async () => {
  const f = await fixture();
  await db.prisma.runtimeInstruction.create({ data: {
    id: `workflow:${f.session.id}:plan:implement`, sessionId: f.session.id, text: "Previously prepared execution prompt", state: "preparing",
  } });
  await queueInstruction(db.prisma, { sessionId: f.session.id, requestId: "later-feedback", text: "Later owner feedback" });
  expect((await continuePlanningSession(f.input))?.status).toBe("delivered");
  for (let i = 0; i < 50 && f.runtime.sentMessages.length === 0; i++) await Bun.sleep(5);
  expect(f.compositions).toHaveLength(0);
  expect(f.runtime.sentMessages).toHaveLength(1);
  expect(f.runtime.sentMessages[0]?.text).toBe("Previously prepared execution prompt");
  for (let i = 0; i < 50 && (await db.prisma.runtimeInstruction.findFirst({ where: { state: "dispatching" } })); i++) await Bun.sleep(5);
  await deliverInstructions(db.prisma, f.runtime);
  await f.settle();
  expect(f.runtime.sentMessages.map((m) => m.text)).toEqual(["Previously prepared execution prompt", "Later owner feedback"]);
  expect(await db.prisma.runtimeInstruction.count()).toBe(2);
});
