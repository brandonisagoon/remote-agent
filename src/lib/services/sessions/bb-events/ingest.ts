import type { ServerConfig } from "../../../config.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { BbClient } from "../../../../types/runtime/index.ts";
import { advanceBbEventCursor, getBbEventCursor } from "./cursor-store.ts";
import { projectBbEvent } from "./projection.ts";

const DISCOVERY_INTERVAL_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export function bbEventRetryDelayMs(failureCount: number): number {
  return Math.min(
    DISCOVERY_INTERVAL_MS * 2 ** Math.max(0, failureCount - 1),
    MAX_RETRY_DELAY_MS,
  );
}

export interface BbEventIngestion {
  stop(): Promise<void>;
}

export function startBbEventIngestion(input: {
  config: ServerConfig;
  prisma: PrismaClient;
  bbClient: BbClient;
}): BbEventIngestion {
  const controllers = new Map<string, AbortController>();
  const consumers = new Set<Promise<void>>();
  const failureCounts = new Map<string, number>();
  const retryAfter = new Map<string, number>();
  let stopped = false;

  const consume = async (threadId: string, controller: AbortController) => {
    try {
      const afterSeq = await getBbEventCursor(input.prisma, threadId);
      for await (const event of input.bbClient.streamEvents({
        threadId,
        afterSeq,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        const cursor = await getBbEventCursor(input.prisma, threadId);
        if (event.seq <= cursor) continue;
        await projectBbEvent(input.config, input.prisma, event, {
          bbClient: input.bbClient,
        });
        await advanceBbEventCursor(input.prisma, {
          bbThreadId: threadId,
          seq: event.seq,
        });
        failureCounts.delete(threadId);
        retryAfter.delete(threadId);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const failureCount = (failureCounts.get(threadId) ?? 0) + 1;
        const delay = bbEventRetryDelayMs(failureCount);
        failureCounts.set(threadId, failureCount);
        retryAfter.set(threadId, Date.now() + delay);
        console.error(
          `[bb-events] consumer failed for ${threadId}; retrying in ${delay}ms:`,
          error,
        );
      }
    } finally {
      controllers.delete(threadId);
    }
  };

  const discover = async () => {
    if (stopped) return;
    const threads = await input.bbClient.listThreads({
      projectId: input.config.bbProjectId,
      archived: false,
    });
    for (const thread of threads) {
      if (controllers.has(thread.id)) continue;
      const blockedUntil = retryAfter.get(thread.id);
      if (blockedUntil && blockedUntil > Date.now()) continue;
      const controller = new AbortController();
      controllers.set(thread.id, controller);
      const consumer = consume(thread.id, controller).finally(() => {
        consumers.delete(consumer);
      });
      consumers.add(consumer);
    }
  };

  void discover().catch((error) => {
    console.error("[bb-events] initial discovery failed:", error);
  });
  const timer = setInterval(() => {
    void discover().catch((error) => {
      console.error("[bb-events] discovery failed:", error);
    });
  }, DISCOVERY_INTERVAL_MS);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(consumers);
    },
  };
}
