import { createTestDatabase } from "../../../../../test-support/db.ts";
import { takeNativeOwnership } from "../../../services/launches/native-takeover.ts";
import { createFakeAgentRuntime } from "../../../../../test-support/agent-runtime.ts";
import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import { DispatchEventType, type DispatchEvent } from "../../../../../types/dispatcher/index.ts";
import type { WorkerContext } from "../../../../../types/dispatcher/index.ts";
import { testConfig } from "../../../../../test-support/config.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";
import { acknowledgementReaction, buildWorkflowSeedPrompt, createWorkflowWorker, type WorkflowWorkerDependencies } from "./worker.ts";

type WorkflowEvent = Extract<DispatchEvent, { type: typeof DispatchEventType.TrackerWorkflowTriggered }>;

const ISSUE: SourceIssueWithAgentIssues = {
  id: "issue-uuid",
  identifier: "CUBE-42",
  title: "Fix the flaky test",
  description: "Reproduce the intermittent failure and preserve the public API.",
  branchName: "feature/fix-cube-42",
  state: { name: "Planning", type: "started" },
  updatedAt: new Date(Date.now() - 600_000).toISOString(),
  documentContent: { id: "description-id", updatedAt: new Date(Date.now() - 600_000).toISOString() },
  labels: { nodes: [] },
  agentIssues: [],
} as unknown as SourceIssueWithAgentIssues;

const OWNER = "owner-uuid";
const recently = () => new Date(Date.now() - 60_000).toISOString();

/** Owner-routed config: only configured owners can start execution. */
function ownerConfig() {
  const config = testConfig();
  config.webhooks[config.activeWebhookId]!.repositoryRouting[config.repository.id] = { when: [{ "linear.userId": [OWNER] }] };
  return config;
}

function issueEvent(workflowId: string): WorkflowEvent {
  return {
    type: DispatchEventType.TrackerWorkflowTriggered,
    workflowId,
    webhook: {
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
      actor: { id: OWNER },
      data: { id: "issue-uuid", identifier: "CUBE-42", updatedAt: recently(), state: { name: "Planning", type: "started" } },
    },
  } as WorkflowEvent;
}

function reactionEvent(workflowId: string, emoji: string): WorkflowEvent {
  return {
    type: DispatchEventType.TrackerWorkflowTriggered,
    workflowId,
    webhook: {
      type: "Reaction", action: "create", webhookTimestamp: Date.now(),
      data: { id: "reaction-uuid", emoji, userId: OWNER, createdAt: recently(), issueId: "issue-uuid", issue: { id: "issue-uuid", identifier: "CUBE-42" } },
    },
  } as WorkflowEvent;
}

function context(overrides: {
  showRef?: { ok: boolean; stdout?: string; stderr?: string };
} = {}): WorkerContext {
  return {
    prisma: {} as PrismaClient,
    config: ownerConfig(),
    agentRuntime: {} as WorkerContext["agentRuntime"],
    runId: "run-1",
    commandClient: {
      run: async () =>
        overrides.showRef ?? { ok: false, exitCode: 1, stdout: "", stderr: "" },
    } as unknown as WorkerContext["commandClient"],
  };
}

interface Recorded {
  provisioned: string[];
  directories: Array<string | null>;
  launched: Array<Record<string, unknown>>;
  reactions: string[];
  comments: number;
  forwarded: Array<Record<string, unknown>>;
}

function dependencies(record: Recorded, overrides: Partial<WorkflowWorkerDependencies> = {}): WorkflowWorkerDependencies {
  return {
    assertLaunch: async () => {},
    getIssue: async () => ISSUE,
    readComments: async () => [],
    react: (async (_key: string, _issue: string, reaction: string) => {
      record.reactions.push(reaction);
      return true;
    }) as WorkflowWorkerDependencies["react"],
    postWorktreeComment: (async () => {
      record.comments += 1;
      return "posted" as const;
    }) as WorkflowWorkerDependencies["postWorktreeComment"],
    compose: async (_worktree, prompt, harness) =>
      prompt.replaceAll(/{{SKILL:([a-z0-9+-]+)}}/g, (_m, token) =>
        harness === "claude" ? `/composed-${token}` : `$composed-${token}`),
    provision: async ({ branchName, directoryName }) => {
      record.provisioned.push(branchName);
      record.directories.push(directoryName ?? null);
      return `/worktrees/${branchName}`;
    },
    launch: (async (input: Record<string, unknown>) => {
      record.launched.push(input);
      return { session: { id: "runtime_1" } };
    }) as unknown as WorkflowWorkerDependencies["launch"],
    forward: (async (input: Record<string, unknown>) => {
      record.forwarded.push(input);
      return { status: "delivered", detail: "forwarded", targetResourceId: null };
    }) as unknown as WorkflowWorkerDependencies["forward"],
    hasLiveSession: async () => false,
    continuePlan: async () => null,
    ...overrides,
  };
}

function recorded(): Recorded {
  return { provisioned: [], directories: [], launched: [], reactions: [], comments: 0, forwarded: [] };
}

describe("workflow worker", () => {
  test("start-session provisions, composes the skill, launches, and reports", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const result = await worker.execute(issueEvent("plan") as never, context());

    expect(result.status).toBe("delivered");
    expect(String(record.launched[0]?.prompt)).toContain(ISSUE.description!);
    expect(record.provisioned).toEqual(["feature/fix-cube-42"]);
    expect(record.directories).toEqual(["feature-fix-cube-42"]);
    expect(record.launched).toHaveLength(1);
    const launch = record.launched[0]!;
    expect(launch.provider).toBe("codex");
    expect(launch.title).toBe("tracker-plan-cube-42");
    expect(String(launch.prompt)).toContain("$composed-orchestrate");
    expect(String(launch.prompt)).toContain("- workflow: plan");
    expect(record.comments).toBe(1);
  });

  test.each(["pencil2", "rocket", "eyes"])("reaction-triggered workflows acknowledge with the triggering %s reaction", async (emoji) => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const ctx = context();
    const repository = { ...ctx.config.repository, workflows: { ...ctx.config.repository.workflows,
      describe: { ...ctx.config.repository.workflows.describe!, when: [{ "reaction.emoji": ["pencil2", "rocket", "eyes"] }] } } };
    await worker.execute(reactionEvent("describe", emoji) as never, { ...ctx, config: { ...ctx.config, repository } });
    expect(record.reactions).toEqual([emoji]);
  });

  test("acknowledgement follows the event rather than workflow name", () => {
    expect(acknowledgementReaction(reactionEvent("implement", "rocket") as never)).toBe("rocket");
    expect(acknowledgementReaction(issueEvent("plan") as never)).toBe("memo");
  });

  test("state-triggered workflows acknowledge with the plan memo", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    await worker.execute(issueEvent("plan") as never, context());
    expect(record.reactions).toEqual(["memo"]);
  });

  test("ignores issues that already have a live persistent session", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record, { hasLiveSession: async () => true }));
    const result = await worker.execute(issueEvent("plan") as never, context());
    expect(result.status).toBe("ignored");
    expect(record.launched).toHaveLength(0);
  });

  test("reports existing branches without launching", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const result = await worker.execute(
      issueEvent("plan") as never,
      context({ showRef: { ok: true } }),
    );
    expect(result.status).toBe("existing");
    expect(record.launched).toHaveLength(0);
  });

  test("fails when composition fails, before any session exists", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record, {
      compose: async () => {
        throw new Error("Unknown skillset: orchestrate");
      },
    }));
    const result = await worker.execute(issueEvent("plan") as never, context());
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Unknown skillset");
    expect(record.launched).toHaveLength(0);
  });

  test("message-session composes in the target worktree and forwards", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const result = await worker.execute(issueEvent("review") as never, context());
    expect(result.status).toBe("delivered");
    expect(record.forwarded).toHaveLength(1);
    const forwarded = record.forwarded[0]! as {
      finalizeMessage: (target: { runtime: { worktreePath: string } }) => Promise<string>;
    };
    const message = await forwarded.finalizeMessage({ runtime: { worktreePath: "/wt" } });
    expect(message).toContain("composed-reflect");
    expect(record.launched).toHaveLength(0);
  });

  test("fails cleanly when the workflow was removed from config", async () => {
    const worker = createWorkflowWorker(dependencies(recorded()));
    const result = await worker.execute(issueEvent("gone") as never, context());
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("no longer configured");
  });

  test("the repository's branch template overrides the provider's name", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const base = ownerConfig();
    const repository = {
      ...base.repository,
      branchNaming: { "*": "{branch}", linear: "agent/{issue}-{title}" },
    };
    const templateContext = { ...context(), config: { ...base, repository } };
    const result = await worker.execute(issueEvent("plan") as never, templateContext);
    expect(result.status).toBe("delivered");
    expect(record.provisioned).toEqual(["agent/cube-42-fix-the-flaky-test"]);
  });

  test("per-connection worktree templates shape the directory", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const base = ownerConfig();
    const repository = {
      ...base.repository,
      worktreeNaming: { "*": "{branch}", [base.activeConnectionId]: "{issue}" },
    };
    const overrideContext = { ...context(), config: { ...base, repository } };
    await worker.execute(issueEvent("plan") as never, overrideContext);
    expect(record.directories).toEqual(["cube-42"]);
  });

  test("launches carry workflow provenance and plan mode when capture is on", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const base = ownerConfig();
    const repository = {
      ...base.repository,
      workflows: {
        ...base.repository.workflows,
        "plan-capture": {
          id: "plan-capture",
          connectionId: null,
          on: "issue.state-changed" as const,
          when: null,
          skill: { skillset: "orchestrate", flags: [] },
          deliver: "start-session" as const,
          providerId: "claude" as const,
          model: null,
          plan: { captureToIssue: true as const, thenState: "Planned" },
        },
      },
    };
    const planContext = {
      ...context(),
      config: { ...base, repository, repositories: { [repository.id]: repository } },
    };
    const result = await worker.execute(issueEvent("plan-capture") as never, planContext);
    expect(result.status).toBe("delivered");
    const launch = record.launched[0]!;
    expect(launch.workflowId).toBe("plan-capture");
    expect(launch.mode).toBe("plan");
  });

  test("launches without plan capture set provenance but no mode", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    await worker.execute(issueEvent("plan") as never, context());
    const launch = record.launched[0]!;
    expect(launch.workflowId).toBe("plan");
    expect(launch.mode).toBeUndefined();
  });

  test("seed prompts embed the flagged skill token", () => {
    const prompt = buildWorkflowSeedPrompt(
      {
        id: "plan",
        connectionId: null,
        on: "issue.state-changed",
        when: null,
        skill: { skillset: "orchestrate", flags: ["tunnel"] },
        deliver: "start-session",
        providerId: null,
        model: null,
        plan: null,
      },
      { branchName: "feature/x" },
    );
    expect(prompt).toContain("{{SKILL:orchestrate+tunnel}}");
    expect(prompt).toContain("- branchName: feature/x");
  });
});


test.each(["provision", "compose"] as const)("native ownership during %s prevents the accepted worker from launching", async stage => {
  const db = await createTestDatabase(), runtime = createFakeAgentRuntime(), ctx = context(), record = recorded();
  ctx.prisma = db.prisma; ctx.agentRuntime = runtime;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), resume = new Promise<void>(resolve => release = resolve);
  const base = dependencies(record);
  const deps = { ...base, assertLaunch: undefined, hasLiveSession: async () => false,
    provision: async (input: Parameters<NonNullable<WorkflowWorkerDependencies["provision"]>>[0]) => { if (stage === "provision") { entered(); await resume; } return base.provision!(input); },
    compose: async (...args: Parameters<NonNullable<WorkflowWorkerDependencies["compose"]>>) => { if (stage === "compose") { entered(); await resume; } return base.compose!(...args); },
  };
  const work = createWorkflowWorker(deps).execute(issueEvent("plan"), ctx);
  await waiting;
  try {
    const source = { connectionId: ctx.config.activeConnectionId, repositoryId: ctx.config.repository.id, issueId: ISSUE.id, issueIdentifier: ISSUE.identifier };
    expect((await takeNativeOwnership({ prisma: db.prisma, config: ctx.config, runtime }, { source, expectedRevision: 0, requestKey: "native", nativeChat: { hostId: "local", threadId: "native" } })).state).toBe("pending");
  } finally { release(); }
  try { expect((await work).status).toBe("ignored"); expect(record.launched).toHaveLength(0); expect(record.reactions).toHaveLength(0); }
  finally { await db.cleanup(); }
});


test("a withdrawn accepted workflow acknowledges without a provider lookup, including replay under a new delivery", async () => {
  const db = await createTestDatabase(), runtime = createFakeAgentRuntime(), ctx = context(), record = recorded();
  ctx.prisma = db.prisma; ctx.agentRuntime = runtime;
  try {
    const source = { connectionId: ctx.config.activeConnectionId, repositoryId: ctx.config.repository.id, issueId: ISSUE.id, issueIdentifier: ISSUE.identifier };
    await takeNativeOwnership({ prisma: db.prisma, config: ctx.config, runtime }, { source, expectedRevision: 0, requestKey: "native", nativeChat: { hostId: "local", threadId: "native" } });
    let lookups = 0;
    const worker = createWorkflowWorker(dependencies(record, { assertLaunch: undefined, getIssue: async () => { lookups++; throw new Error("Provider must not be needed for a saved withdrawal"); } }));
    expect((await worker.execute(issueEvent("plan"), ctx)).status).toBe("ignored");
    expect((await worker.execute(reactionEvent("plan", "🚀"), { ...ctx, runId: "new-delivery-same-old-intent" })).status).toBe("ignored");
    expect(lookups).toBe(0); expect(record.launched).toHaveLength(0);
  } finally { await db.cleanup(); }
});
