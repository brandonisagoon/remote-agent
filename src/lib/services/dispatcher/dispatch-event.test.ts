import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../generated/prisma/client.ts";
import { testConfig } from "../../../test-support/config.ts";
import {
  DispatchEventType,
  type DispatchEvent,
  type Worker,
  type WorkerResult,
} from "../../../types/dispatcher/index.ts";
import type { CommandClient } from "../../../types/runtime/index.ts";
import { Reaction } from "../../integrations/linear/index.ts";
import {
  dispatchEvent,
  type DispatchEventDependencies,
} from "./dispatch-event.ts";

const prisma = {} as PrismaClient;
const commandClient: CommandClient = {
  run: async () => ({ ok: true, stdout: "", stderr: "" }),
};

function issueEvent(): DispatchEvent {
  return {
    type: DispatchEventType.LinearIssueOrchestrationRequested,
    webhook: {
      type: "Issue",
      action: "update",
      webhookTimestamp: 1,
      data: { id: "issue-id", identifier: "CUBE-3129" },
    },
  };
}

function worker(
  key: string,
  execute: () => Promise<WorkerResult>,
): Worker {
  return {
    key,
    supports: (event): event is DispatchEvent => Boolean(event),
    execute,
  };
}

function dependencies(
  selectedWorker: Worker,
  events: string[],
): DispatchEventDependencies {
  return {
    workers: [selectedWorker],
    startRun: async () => ({ id: "run-id" }),
    finishRun: async (_prisma, runId, result) => {
      events.push(`finish:${runId}:${result.status}:${result.detail}`);
    },
    react: async (_key, issueId, reaction) => {
      events.push(`react:${issueId}:${reaction}`);
      return true;
    },
  };
}

describe("dispatch event failure reaction", () => {
  test("reacts before persisting a failed orchestration result", async () => {
    const events: string[] = [];
    await dispatchEvent(
      {
        prisma,
        config: testConfig(),
        commandClient,
        receiptId: "receipt-id",
        event: issueEvent(),
      },
      dependencies(
        worker("product.orchestration", async () => ({
          status: "failed",
          detail: "bb launch failed",
          targetAgentIssueIdentifier: null,
        })),
        events,
      ),
    );

    expect(events).toEqual([
      `react:issue-id:${Reaction.Failed}`,
      "finish:run-id:failed:bb launch failed",
    ]);
  });

  test("reacts when the launch worker throws", async () => {
    const events: string[] = [];
    await dispatchEvent(
      {
        prisma,
        config: testConfig(),
        commandClient,
        receiptId: "receipt-id",
        event: issueEvent(),
      },
      dependencies(
        worker("product.describe", async () => {
          throw new Error("launcher exploded");
        }),
        events,
      ),
    );

    expect(events).toEqual([
      `react:issue-id:${Reaction.Failed}`,
      "finish:run-id:failed:launcher exploded",
    ]);
  });

  test("does not duplicate failure ownership for agent mentions", async () => {
    const events: string[] = [];
    await dispatchEvent(
      {
        prisma,
        config: testConfig(),
        commandClient,
        receiptId: "receipt-id",
        event: issueEvent(),
      },
      dependencies(
        worker("product.agent-mention", async () => ({
          status: "failed",
          detail: "routing failed",
          targetAgentIssueIdentifier: null,
        })),
        events,
      ),
    );

    expect(events).toEqual(["finish:run-id:failed:routing failed"]);
  });
});
