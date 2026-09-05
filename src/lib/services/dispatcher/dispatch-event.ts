import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../config.ts";
import type { AgentSessionRuntime, CommandClient } from "../../../types/runtime/index.ts";
import type {
  DispatchEvent,
  Worker,
  WorkerResult,
} from "../../../types/dispatcher/index.ts";
import { TrackerReaction, reactToIssue } from "../../integrations/linear/reactions.ts";
import { eventIssueId } from "./event-issue.ts";
// Loaded lazily at dispatch time: workers import broad service barrels that
// can (via webhook handlers) import this dispatcher back. A static import
// would put the registry inside that cycle and hit TDZ during module init.
async function loadWorkers() {
  const { workers } = await import("./worker-registry.ts");
  return workers;
}
import { finishWorkerRun, startWorkerRun } from "./worker-run-store.ts";

const FAILURE_REACTION_WORKERS = new Set(["product.workflow"]);

export interface DispatchEventDependencies {
  /** Injected by tests; production loads the registry lazily. */
  workers?: Worker[];
  startRun: (
    prisma: PrismaClient,
    receiptId: string,
    workerKey: string,
  ) => PromiseLike<{ id: string }>;
  finishRun: (
    prisma: PrismaClient,
    runId: string,
    result: WorkerResult,
  ) => PromiseLike<unknown>;
  react: typeof reactToIssue;
}

const defaultDependencies: DispatchEventDependencies = {
  startRun: startWorkerRun,
  finishRun: finishWorkerRun,
  react: reactToIssue,
};

export async function dispatchEvent(
  input: {
    prisma: PrismaClient;
    config: ServerConfig;
    commandClient: CommandClient;
    agentRuntime: AgentSessionRuntime;
    receiptId: string;
    event: DispatchEvent;
  },
  dependencies: DispatchEventDependencies = defaultDependencies,
): Promise<void> {
  for (const worker of (dependencies.workers ?? (await loadWorkers())).filter((entry) =>
    entry.supports(input.event),
  )) {
    const run = await dependencies.startRun(
      input.prisma,
      input.receiptId,
      worker.key,
    );
    let result: WorkerResult;
    try {
      result = await worker.execute(input.event, {
        prisma: input.prisma,
        config: input.config,
        commandClient: input.commandClient,
        agentRuntime: input.agentRuntime,
        runId: run.id,
      });
    } catch (error) {
      result = {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        targetAgentIssueIdentifier: null,
      };
    }
    if (
      result.status === "failed" &&
      FAILURE_REACTION_WORKERS.has(worker.key)
    ) {
      const issueId = eventIssueId(input.event);
      if (issueId) {
        await dependencies
          .react(input.config.linearApiKey, issueId, TrackerReaction.Failed)
          .catch((error) => {
            console.error(`Failed to react to issue ${issueId}:`, error);
          });
      }
    }
    await Promise.resolve(
      dependencies.finishRun(input.prisma, run.id, result),
    ).catch((error) => {
      console.error(`Failed to finish worker run ${run.id}:`, error);
    });
  }
}
