import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createFakeBbClient } from "../../../../test-support/bb.ts";
import { DispatchEventType } from "../../../../types/dispatcher/index.ts";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import type { SourceIssueWithAgentIssues } from "../../../integrations/tracker/index.ts";
import {
  createDescribeWorker,
  type DescribeWorkerDependencies,
} from "./worker.ts";

const SOURCE_ISSUE: SourceIssueWithAgentIssues = {
  id: "issue-id",
  identifier: "DEMO-42",
  branchName: "describe-demo-42",
  title: "Describe the public API",
  description: null,
  state: { name: "On Course" },
  labels: { nodes: [{ name: "Feature", parent: { name: "Product" } }] },
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
};

const EVENT = {
  type: DispatchEventType.TrackerIssueDescribeRequested,
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
        identifier: "DEMO-42",
        title: "Describe the public API",
      },
    },
  },
};

function context() {
  return {
    prisma: {} as PrismaClient,
    config: testConfig(),
    commandClient: {} as CommandClient,
    bbClient: createFakeBbClient(),
    runId: "run-id",
  };
}

function dependencies(
  overrides: Partial<DescribeWorkerDependencies> = {},
): DescribeWorkerDependencies {
  return {
    exists: () => true,
    readPrompt: () => "Describe {{sourceIssueIdentifier}} for another engineer.",
    getIssue: async () => SOURCE_ISSUE,
    react: async () => true,
    launch: async () => ({
      thread: {
        id: "thr_describe",
        projectId: "proj_test",
        environmentId: "env_test",
        hostId: "host_air",
        providerId: "claude-code",
        title: "tracker-describe-demo-42",
        status: "starting",
        parentThreadId: null,
        archivedAt: null,
      },
      agentIssue: null,
    }),
    ...overrides,
  };
}

describe("describeWorker", () => {
  test("fails before lookup when the configured prompt is missing", async () => {
    let lookups = 0;
    const worker = createDescribeWorker(
      dependencies({
        exists: () => false,
        getIssue: async () => {
          lookups += 1;
          return SOURCE_ISSUE;
        },
      }),
    );

    const result = await worker.execute(EVENT, context());
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("required describe prompt is missing");
    expect(lookups).toBe(0);
  });

  test("launches from repository config and renders source context", async () => {
    const launches: Parameters<NonNullable<DescribeWorkerDependencies["launch"]>>[0][] = [];
    const base = dependencies();
    const worker = createDescribeWorker({
      ...base,
      launch: async (input) => {
        launches.push(input);
        return base.launch!(input);
      },
    });

    const result = await worker.execute(EVENT, context());
    expect(result.status).toBe("delivered");
    expect(launches[0]).toMatchObject({
      worktreePath: "/nonexistent/repository",
      harness: "claude",
      model: "opus",
    });
    expect(launches[0]!.prompt).toContain("Describe DEMO-42");
    expect(launches[0]!.prompt).toContain("sourceIssueLabels: Feature");
  });

  test("rejects an empty prompt and a failed launch", async () => {
    const empty = createDescribeWorker(dependencies({ readPrompt: () => " " }));
    expect((await empty.execute(EVENT, context())).detail).toBe(
      "describe workflow prompt is empty",
    );

    const failed = createDescribeWorker(
      dependencies({
        launch: async () => {
          throw new Error("bb unavailable");
        },
      }),
    );
    expect((await failed.execute(EVENT, context())).detail).toContain(
      "bb launch failed: bb unavailable",
    );
  });
});
