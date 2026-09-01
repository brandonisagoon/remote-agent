import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import {
  agentIssueFixture,
  agentIssueRuntimeDescription,
} from "../../../../test-support/agent-issue.ts";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import {
  DispatchEventType,
  WorkerRunStatus,
} from "../../../../types/dispatcher/index.ts";
import { testConfig } from "../../../../test-support/config.ts";
import {
  createFakeAgentRuntime,
  fakeRuntimeSession,
} from "../../../../test-support/agent-runtime.ts";
import {
  createOrchestrationWorker,
  type OrchestrationWorkerDependencies,
} from "./worker.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "orchestration-worker-"));
  tempDirectories.push(root);
  const prompt = path.join(root, "prompts", "orchestrate-plan.md");
  mkdirSync(path.dirname(prompt), { recursive: true });
  writeFileSync(prompt, "Plan {{sourceIssueIdentifier}} and execute it.\n");
  return root;
}

function issue(): SourceIssueWithAgentIssues {
  return {
    id: "issue-id",
    identifier: "CUBE-2774",
    branchName: "webhook-orchestration-cube-2774",
    title: "Webhook orchestration",
    description: null,
    state: { name: "Planning" },
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
}

function event() {
  return {
    type: DispatchEventType.TrackerIssueOrchestrationRequested,
    webhook: {
      type: "Issue" as const,
      action: "update" as const,
      webhookTimestamp: Date.now(),
      data: {
        id: "issue-id",
        identifier: "CUBE-2774",
        state: { name: "Planning", type: "unstarted" },
        team: { key: "CUBE" },
      },
      updatedFrom: { stateId: "todo-id" },
    },
  };
}

function commandClient(
  results: Array<{ ok: boolean; stdout: string; stderr: string }>,
) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const client: CommandClient = {
    async run(command, args) {
      calls.push({ command, args });
      return results.shift() ?? { ok: true, stdout: "", stderr: "" };
    },
  };
  return { calls, client };
}

function context(root: string, client: CommandClient) {
  const base = testConfig();
  return {
    prisma: {} as PrismaClient,
    config: {
      ...base,
      repository: {
        ...base.repository,
        root,
        worktreeRoot: path.join(path.dirname(root), ".worktrees"),
      },
    },
    commandClient: client,
    agentRuntime: createFakeAgentRuntime(),
    runId: "run-id",
  };
}

function createWorker(
  dependencies: Omit<OrchestrationWorkerDependencies, "react"> &
    Partial<Pick<OrchestrationWorkerDependencies, "react">>,
) {
  return createOrchestrationWorker({
    react: async () => true,
    provision: async () => "/tmp/provisioned-worktree",
    launch: async () => ({
      session: fakeRuntimeSession({ id: "runtime_orchestration" }),
      agentIssue: null,
    }),
    ...dependencies,
  });
}

function reactionSpy() {
  let callCount = 0;
  const react: OrchestrationWorkerDependencies["react"] = async () => {
    callCount += 1;
    return true;
  };
  return { react, callCount: () => callCount };
}

describe("orchestrationWorker", () => {
  test("fails before Linear lookup when launcher files are missing", async () => {
    const reaction = reactionSpy();
    const worker = createWorker({
      exists: () => false,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => "posted",
    });
    const commands = commandClient([]);

    const result = await worker.execute(
      event(),
      context("/missing/repo", commands.client),
    );

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("required orchestration prompt is missing");
    expect(commands.calls).toHaveLength(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("fails without reacting when the authoritative issue cannot be found", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => null,
      react: reaction.react,
      postWorktreeComment: async () => "posted",
    });
    const commands = commandClient([]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result).toMatchObject({
      status: "failed",
      detail: "source issue not found",
    });
    expect(commands.calls).toHaveLength(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("returns Existing when the branch exists", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    let commentCalls = 0;
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
    });
    const commands = commandClient([{ ok: true, stdout: "", stderr: "" }]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result.status).toBe(WorkerRunStatus.Existing);
    expect(commands.calls.map((call) => call.command)).toEqual(["git"]);
    expect(commentCalls).toBe(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("fails without reacting when git show-ref fails", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => "posted",
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "fatal: not a git repository" },
    ]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result).toMatchObject({
      status: "failed",
      detail: "git show-ref failed: fatal: not a git repository",
    });
    expect(reaction.callCount()).toBe(0);
  });

  test("fails without reacting when the orchestration prompt is empty", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => "posted",
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
    ]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result).toMatchObject({
      status: "failed",
      detail: "orchestration prompt is empty",
    });
    expect(reaction.callCount()).toBe(0);
  });

  test("fails closed when acpx rejects the launch", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    let commentCalls = 0;
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
      launch: async () => { throw new Error("acpx spawn rejected"); },
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      {
        ok: false,
        stdout: "",
        stderr: "duplicate session: linear-orchestrate-cube-2774",
      },
    ]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("acpx spawn rejected");
    expect(commentCalls).toBe(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("launches through acpx after all guards pass", async () => {
    const root = fixtureRoot();
    const commentCalls: Array<{
      issueId: string;
      branchName: string;
    }> = [];
    const reactionCalls: Array<{
      apiKey: string;
      issueId: string;
      emoji: string;
    }> = [];
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "Use /orchestrate-plan-linear",
      getIssue: async () => issue(),
      react: async (apiKey, issueId, emoji) => {
        reactionCalls.push({ apiKey, issueId, emoji });
        return true;
      },
      postWorktreeComment: async ({ issueId, branchName }) => {
        commentCalls.push({ issueId, branchName });
        return "posted";
      },
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result).toEqual({
      status: "delivered",
      detail:
        "runtime_session:runtime_orchestration started; memo reaction posted; worktree link comment posted",
      targetAgentIssueIdentifier: "CUBE-2774",
    });
    expect(reactionCalls).toEqual([
      {
        apiKey: "test-linear-key",
        issueId: "issue-id",
        emoji: "memo",
      },
    ]);
    expect(commentCalls).toEqual([
      {
        issueId: "issue-id",
        branchName: "webhook-orchestration-cube-2774",
      },
    ]);
    expect(commands.calls.map((call) => call.command)).toEqual(["git"]);
  });

  test("does not post a comment when orchestration is ignored", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    let commentCalls = 0;
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => ({
        ...issue(),
        state: { name: "On Course" },
      }),
      react: reaction.react,
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
    });
    const commands = commandClient([]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result.status).toBe("ignored");
    expect(commentCalls).toBe(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("does not launch or comment for a live related session", async () => {
    const root = fixtureRoot();
    let commentCalls = 0;
    const related = agentIssueFixture();
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => ({
        ...issue(),
        relations: {
          nodes: [{ type: "related", agentIssue: related }],
        },
      }),
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
    });
    const commands = commandClient([]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result.status).toBe("ignored");
    expect(commands.calls).toHaveLength(0);
    expect(commentCalls).toBe(0);
  });

  test("launches for an ended one-shot describe session", async () => {
    const root = fixtureRoot();
    let commentCalls = 0;
    const related = agentIssueFixture({
      description: agentIssueRuntimeDescription("one-shot"),
      state: { id: "ended-id", name: "Ended", type: "completed" },
    });
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => ({
        ...issue(),
        relations: {
          nodes: [{ type: "related", agentIssue: related }],
        },
      }),
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result.status).toBe("delivered");
    expect(commands.calls.map((call) => call.command)).toEqual(["git"]);
    expect(commentCalls).toBe(1);
  });

  test("does not post a comment when acpx launch fails", async () => {
    const root = fixtureRoot();
    const reaction = reactionSpy();
    let commentCalls = 0;
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: reaction.react,
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
      launch: async () => { throw new Error("acpx unavailable"); },
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      { ok: false, stdout: "", stderr: "unused command failure" },
    ]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result.status).toBe("failed");
    expect(commentCalls).toBe(0);
    expect(reaction.callCount()).toBe(0);
  });

  test("keeps a successful launch delivered when the reaction fails", async () => {
    const root = fixtureRoot();
    let commentCalls = 0;
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      react: async () => false,
      postWorktreeComment: async () => {
        commentCalls += 1;
        return "posted";
      },
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await worker.execute(event(), context(root, commands.client));

    expect(result).toMatchObject({
      status: "delivered",
      detail:
        "runtime_session:runtime_orchestration started; memo reaction failed; worktree link comment posted",
    });
    expect(commentCalls).toBe(1);
  });

  test("keeps a successful launch delivered when the comment fails", async () => {
    const root = fixtureRoot();
    const worker = createWorker({
      exists: () => true,
      readPrompt: () => "prompt",
      getIssue: async () => issue(),
      postWorktreeComment: async () => "failed",
    });
    const commands = commandClient([
      { ok: false, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
    ]);

    const result = await worker.execute(
      event(),
      context(root, commands.client),
    );

    expect(result).toMatchObject({
      status: "delivered",
      detail:
        "runtime_session:runtime_orchestration started; memo reaction posted; worktree link comment failed",
    });
  });
});
