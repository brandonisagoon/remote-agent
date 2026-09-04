import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { DispatchEventType, type DispatchEvent } from "../../../../types/dispatcher/index.ts";
import type { WorkerContext } from "../../../../types/dispatcher/index.ts";
import { testConfig } from "../../../../test-support/config.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/linear/session-store/source-issue/types.ts";
import { buildWorkflowSeedPrompt, createWorkflowWorker, type WorkflowWorkerDependencies } from "./worker.ts";

const ISSUE: SourceIssueWithAgentIssues = {
  id: "issue-uuid",
  identifier: "CUBE-42",
  title: "Fix the flaky test",
  branchName: "feature/fix-cube-42",
  state: { name: "Planning" },
  labels: { nodes: [] },
  agentIssues: [],
} as unknown as SourceIssueWithAgentIssues;

function issueEvent(workflowId: string): DispatchEvent {
  return {
    type: DispatchEventType.TrackerWorkflowTriggered,
    workflowId,
    webhook: {
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
      data: { id: "issue-uuid", identifier: "CUBE-42", state: { name: "Planning" } },
    },
  } as DispatchEvent;
}

function context(overrides: {
  showRef?: { ok: boolean; stdout?: string; stderr?: string };
} = {}): WorkerContext {
  return {
    prisma: {} as PrismaClient,
    config: testConfig(),
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
  launched: Array<Record<string, unknown>>;
  reactions: string[];
  comments: number;
  forwarded: Array<Record<string, unknown>>;
}

function dependencies(record: Recorded, overrides: Partial<WorkflowWorkerDependencies> = {}): WorkflowWorkerDependencies {
  return {
    getIssue: async () => ISSUE,
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
    provision: async ({ branchName }) => {
      record.provisioned.push(branchName);
      return `/worktrees/${branchName}`;
    },
    launch: (async (input: Record<string, unknown>) => {
      record.launched.push(input);
      return { session: { id: "runtime_1" } };
    }) as unknown as WorkflowWorkerDependencies["launch"],
    forward: (async (input: Record<string, unknown>) => {
      record.forwarded.push(input);
      return { status: "delivered", detail: "forwarded", targetAgentIssueIdentifier: null };
    }) as unknown as WorkflowWorkerDependencies["forward"],
    hasLiveSession: async () => false,
    ...overrides,
  };
}

function recorded(): Recorded {
  return { provisioned: [], launched: [], reactions: [], comments: 0, forwarded: [] };
}

describe("workflow worker", () => {
  test("start-session provisions, composes the skill, launches, and reports", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    const result = await worker.execute(issueEvent("plan") as never, context());

    expect(result.status).toBe("delivered");
    expect(record.provisioned).toEqual(["feature/fix-cube-42"]);
    expect(record.launched).toHaveLength(1);
    const launch = record.launched[0]!;
    expect(launch.harness).toBe("codex");
    expect(launch.title).toBe("tracker-plan-cube-42");
    expect(String(launch.prompt)).toContain("$composed-orchestrate");
    expect(String(launch.prompt)).toContain("- workflow: plan");
    expect(record.comments).toBe(1);
  });

  test("reaction-triggered workflows acknowledge with the describe reaction", async () => {
    const record = recorded();
    const worker = createWorkflowWorker(dependencies(record));
    await worker.execute(issueEvent("describe") as never, context());
    expect(record.reactions).toEqual(["pencil2"]);
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
      },
      { branchName: "feature/x" },
    );
    expect(prompt).toContain("{{SKILL:orchestrate+tunnel}}");
    expect(prompt).toContain("- branchName: feature/x");
  });
});
