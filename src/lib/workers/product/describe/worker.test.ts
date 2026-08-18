import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeBbClient } from "../../../../test-support/bb.ts";
import {
  DispatchEventType,
  WorkerRunStatus,
} from "../../../../types/dispatcher/index.ts";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import type { CubeIssueWithAgentIssues } from "../../../services/sessions/registry/index.ts";
import type {
  ComposeOptions,
  ComposeResult,
} from "../../../workflows/skills.ts";
import {
  createDescribeWorker,
  type DescribeWorkerDependencies,
} from "./worker.ts";

function issue(
  labels: CubeIssueWithAgentIssues["labels"]["nodes"] = [],
  identifier = "CUBE-2804",
): CubeIssueWithAgentIssues {
  return {
    id: "issue-id",
    identifier,
    branchName: "linear-description-cube-2804",
    title: "Describe this issue",
    description: null,
    state: { name: "On Course" },
    labels: { nodes: labels },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
}

function event() {
  return {
    type: DispatchEventType.LinearIssueDescribeRequested,
    webhook: {
      type: "Reaction" as const,
      action: "create",
      webhookTimestamp: Date.now(),
      data: {
        id: "reaction-id",
        emoji: "pencil2",
        userId: "user-id",
        issueId: "issue-id",
        issue: {
          id: "issue-id",
          identifier: "CUBE-2804",
          title: "Describe this issue",
        },
      },
    },
  };
}

function composed(options: ComposeOptions): ComposeResult {
  const suffix =
    options.selection.allSnippets && options.selection.allHooks
      ? "-all"
      : options.selection.snippets.length
        ? `-snippets-${options.selection.snippets.join("-")}`
        : "";
  return {
    skill: `skill-composer-describe-linear-issue${suffix}`,
    skillset: "describe-linear-issue",
    compatibility: { harnesses: ["claude", "codex"] },
    snippets: [...options.selection.snippets],
    hooks: [],
    flags: [...options.selection.flags],
    writes: [],
  };
}

function commandClient(result = { ok: true, stdout: "", stderr: "" }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const client: CommandClient = {
    async run(command, args) {
      calls.push({ command, args });
      return result;
    },
  };
  return { calls, client };
}

function context(client: CommandClient) {
  return {
    prisma: {} as PrismaClient,
    config: testConfig({ workspaceRepoRoot: "/repo" }),
    commandClient: client,
    bbClient: createFakeBbClient(),
    runId: "run-id",
  };
}

function createWorker(
  dependencies: Omit<DescribeWorkerDependencies, "react"> &
    Partial<Pick<DescribeWorkerDependencies, "react">>,
) {
  return createDescribeWorker({
    react: async () => true,
    launch: async () => ({
      thread: {
        id: "thr_describe",
        projectId: "proj_test",
        environmentId: "env_test",
        hostId: "host_air",
        providerId: "claude-code",
        title: "linear-describe-cube-2804",
        status: "starting",
        parentThreadId: null,
        archivedAt: null,
      },
      agentIssue: null,
    }),
    ...dependencies,
  });
}

describe("describeWorker", () => {
  test("fails before lookup when a required file is missing", async () => {
    let lookups = 0;
    const worker = createWorker({
      exists: () => false,
      getIssue: async () => {
        lookups += 1;
        return issue();
      },
      compose: async (options) => composed(options),
    });
    const commands = commandClient();

    const result = await worker.execute(event(), context(commands.client));

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("required describe file is missing");
    expect(lookups).toBe(0);
  });

  test("fails when the authoritative issue cannot be found", async () => {
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => null,
      compose: async (options) => composed(options),
    });

    const result = await worker.execute(
      event(),
      context(commandClient().client),
    );

    expect(result).toMatchObject({
      status: "failed",
      detail: "cube issue not found",
    });
  });

  test("ignores an authoritative Agents-team issue", async () => {
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => issue([], "AGENT-42"),
      compose: async (options) => composed(options),
    });

    const result = await worker.execute(
      event(),
      context(commandClient().client),
    );

    expect(result).toMatchObject({
      status: "ignored",
      detail: "agent_team_issue",
    });
  });

  test("composes all guidance when the issue has no Product child", async () => {
    const composeCalls: ComposeOptions[] = [];
    const worker = createWorker({
      exists: () => true,
      getIssue: async () =>
        issue([{ name: "Bug", parent: { name: "Engineering" } }]),
      compose: async (options) => {
        composeCalls.push(options);
        return composed(options);
      },
    });
    const commands = commandClient();

    const result = await worker.execute(event(), context(commands.client));

    expect(result.status).toBe("delivered");
    expect(composeCalls).toEqual([
      {
        skillset: "describe-linear-issue",
        selection: {
          snippets: [],
          hooks: [],
          flags: [],
          allSnippets: true,
          allHooks: true,
        },
        root: "/repo",
      },
    ]);
    expect(commands.calls).toHaveLength(0);
  });

  test.each([
    ["Bug", "product-label-bug"],
    ["Feature", "product-label-feature"],
    ["UI", "product-label-ui"],
    ["Performance", "product-label-performance"],
    ["Technical Debt", "product-label-technical-debt"],
    ["Dev Ops", "product-label-dev-ops"],
  ])("passes only Product > %s to the composer", async (label, snippet) => {
    const composeCalls: ComposeOptions[] = [];
    const worker = createWorker({
      exists: () => true,
      getIssue: async () =>
        issue([{ name: label, parent: { name: "Product" } }]),
      compose: async (options) => {
        composeCalls.push(options);
        return composed(options);
      },
    });

    const result = await worker.execute(
      event(),
      context(commandClient().client),
    );

    expect(result.status).toBe("delivered");
    expect(composeCalls[0]?.selection.snippets).toEqual([snippet]);
  });

  test("combines Product children and launches the exact generated invocation", async () => {
    const composeCalls: ComposeOptions[] = [];
    const worker = createWorker({
      exists: () => true,
      getIssue: async () =>
        issue([
          { name: "UI", parent: { name: "Product" } },
          { name: "Bug", parent: { name: "Product" } },
        ]),
      compose: async (options) => {
        composeCalls.push(options);
        return composed(options);
      },
    });
    const commands = commandClient();

    const result = await worker.execute(event(), context(commands.client));

    expect(result.status).toBe("delivered");
    expect(composeCalls[0]?.selection.snippets).toEqual([
      "product-label-bug",
      "product-label-ui",
    ]);
    expect(result.detail).toContain("thr_describe");
  });

  test("adds the agent's pencil reaction after the session starts", async () => {
    const reactions: Array<{
      apiKey: string;
      issueId: string;
      emoji: string;
    }> = [];
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => issue(),
      compose: async (options) => composed(options),
      react: async (apiKey, issueId, emoji) => {
        reactions.push({ apiKey, issueId, emoji });
        return true;
      },
    });

    const result = await worker.execute(
      event(),
      context(commandClient().client),
    );

    expect(result).toMatchObject({ status: "delivered" });
    expect(result.detail).toContain("pencil reaction posted");
    expect(reactions).toEqual([
      {
        apiKey: "test-linear-key",
        issueId: "issue-id",
        emoji: "pencil2",
      },
    ]);
  });

  test("keeps a successful session delivered when the pencil reaction fails", async () => {
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => issue(),
      compose: async (options) => composed(options),
      react: async () => false,
    });

    const result = await worker.execute(
      event(),
      context(commandClient().client),
    );

    expect(result).toMatchObject({ status: "delivered" });
    expect(result.detail).toContain("pencil reaction failed");
  });

  test("reports Product-label and composer failures without launching", async () => {
    const commands = commandClient();
    const unsupported = createWorker({
      exists: () => true,
      getIssue: async () =>
        issue([{ name: "Unknown", parent: { name: "Product" } }]),
      compose: async (options) => composed(options),
    });
    const brokenComposer = createWorker({
      exists: () => true,
      getIssue: async () => issue(),
      compose: async () => {
        throw new Error("composer unavailable");
      },
    });

    const unsupportedResult = await unsupported.execute(
      event(),
      context(commands.client),
    );
    const composerResult = await brokenComposer.execute(
      event(),
      context(commands.client),
    );

    expect(unsupportedResult.detail).toContain("unsupported Product label");
    expect(composerResult.detail).toContain("composer unavailable");
    expect(commands.calls).toHaveLength(0);
  });

  test("refuses a composed skill that is incompatible with Claude", async () => {
    const commands = commandClient();
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => issue(),
      compose: async (options) => ({
        ...composed(options),
        compatibility: { harnesses: ["codex"] },
      }),
    });

    const result = await worker.execute(event(), context(commands.client));

    expect(result.detail).toContain("incompatible with claude");
    expect(commands.calls).toHaveLength(0);
  });

  test("reports a rejected bb launch", async () => {
    const worker = createWorker({
      exists: () => true,
      getIssue: async () => issue(),
      compose: async (options) => composed(options),
      launch: async () => { throw new Error("bb spawn rejected"); },
    });
    const result = await worker.execute(event(), context(commandClient().client));

    expect(result).toMatchObject({ status: "failed" });
    expect(result.detail).toContain("bb spawn rejected");
  });
});
