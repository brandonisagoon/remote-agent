import { preparationJournalWorker } from "../../tasks/finalization-preparation.ts";
import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../lib/config.ts";
import {
  agentIssueLabelIdsWithRouting,
  agentIssueRuntimeWithLabels,
  createThreadedIssueComment,
  getAgentCatalog,
  getAgentStateId,
  getSourceIssue,
  parseAgentIssueRuntime,
  parseAgentIssueSourceIdentifier,
  updateAgentIssue,
} from "../../../integrations/tracker/index.ts";
import type {
  AgentRuntimeLifecycleEvent,
  AgentSessionRuntime,
} from "../../../../../types/runtime/index.ts";
import { projectSourceReply } from "../source-messages.ts";
import { reconcileSourceMessages, reconcileControlNotices } from "../../../integrations/linear/message-delivery.ts";
import { AgentIssueState } from "../../../../../types/sessions/index.ts";
import type { AgentIssueStateValue, SessionLifecycle } from "../../../../../types/sessions/index.ts";
import {
  advanceRuntimeEventCursor,
  getRuntimeEventCursor,
  listRuntimeLifecycleEvents,
  pruneRuntimeLifecycleEvents,
} from "../runtime-registry.ts";
import { findAgentIssue } from "../lifecycle/agent-issue/queries/index.ts";
import { projectSourceCheckpoint } from "./source-checkpoint.ts";
import { queueDelegateResult } from "../../launches/delegate-supervision.ts";
import { runRuntimeProjectionAttempt } from "./projection-retries.ts";
import { projectTaskStalls } from "./task-stalls.ts";

const CONSUMER = "linear-projection:v1";
const NOTIFY_CONSUMER = "delegate-notification:v1";
const MAX_OUTPUT = 8_000;
const yieldToRequests = () => new Promise<void>((resolve) => setImmediate(resolve));

function checkpoint(output: string): string {
  const text = output.trim();
  const bounded = text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text;
  return ["### Agent checkpoint", "", bounded].join("\n");
}

export function agentIssueStateForRuntimeEvent(
  event: AgentRuntimeLifecycleEvent,
  lifecycle: SessionLifecycle | null | undefined,
): AgentIssueStateValue {
  if (event.phase === "failed") return AgentIssueState.Error;
  if (event.phase === "cancelled") {
    return lifecycle === "one-shot"
      ? AgentIssueState.Ended
      : AgentIssueState.Disconnected;
  }
  return AgentIssueState.Connected;
}

/** Project low-volume acpx turn lifecycle into the Linear session mirror. */
export async function projectRuntimeEvent(
  config: ServerConfig,
  prisma: PrismaClient,
  runtime: AgentSessionRuntime,
  event: AgentRuntimeLifecycleEvent,
): Promise<boolean> {
  const cursor = await getRuntimeEventCursor(prisma, {
    runtimeSessionId: event.sessionId,
    consumer: CONSUMER,
  });
  const sequence = BigInt(event.sequence ?? 0);
  if (
    cursor.sourceCursor === event.id ||
    (sequence > 0n && cursor.generation >= sequence)
  ) return true;

  const sourceReply = await projectSourceReply(config, prisma, event);

  const session = await prisma.runtimeSession.findUnique({
    where: { id: event.sessionId },
    include: { sessionMirror: true },
  });
  const record = session?.sessionMirror;
  if (!record) {
    if (sourceReply || await projectSourceCheckpoint(config, prisma, runtime, event)) {
      await advanceRuntimeEventCursor(prisma, { runtimeSessionId: event.sessionId, consumer: CONSUMER, sourceCursor: event.id, generation: sequence > 0n ? sequence : cursor.generation + 1n });
      return true;
    }
    return false;
  }
  const issue = await findAgentIssue(config, { id: record.externalId });
  if (!issue) return false;

  const parsed = parseAgentIssueRuntime(issue.description);
  const metadata = parsed ? agentIssueRuntimeWithLabels(issue, parsed) : null;
  const next = agentIssueStateForRuntimeEvent(event, metadata?.lifecycle);
  if (issue.state.name !== next) {
    const catalog = await getAgentCatalog(config);
    const routable =
      next === AgentIssueState.Connected &&
      metadata?.role === "primary" &&
      metadata.machine === config.machine;
    await updateAgentIssue(config, { id: issue.id }, {
      stateId: getAgentStateId(catalog, { name: next }),
      labelIds: agentIssueLabelIdsWithRouting(catalog, issue, routable),
    });
  }

  if (!sourceReply && (event.phase === "completed" || event.phase === "failed")) {
    const sourceIdentifier = parseAgentIssueSourceIdentifier(issue.description);
    const source = sourceIdentifier
      ? await getSourceIssue(config, { id: sourceIdentifier })
      : null;
    if (source) {
      let rootId = record.rootCommentId;
      if (!rootId) {
        const root = await createThreadedIssueComment(config.linearApiKey, {
          issueId: source.id,
          body: `● Remote Agent session · acpx \`${event.sessionId}\``,
        });
        if (root) {
          rootId = root.id;
          await prisma.sessionMirror.update({
            where: { id: record.id },
            data: { rootCommentId: root.id },
          });
        }
      }
      const output = event.phase === "completed"
        ? await runtime.output(event.sessionId)
        : null;
      const body = event.phase === "failed"
        ? ["❌ Agent turn failed", "", event.error ?? "Unknown acpx error"].join("\n")
        : output?.trim()
          ? checkpoint(output)
          : null;
      if (body) {
        const posted = await createThreadedIssueComment(config.linearApiKey, {
          issueId: source.id,
          body,
          ...(rootId ? { parentId: rootId } : {}),
        });
        if (!posted) throw new Error(`failed to project runtime event ${event.id}`);
      }
    }
  }

  await advanceRuntimeEventCursor(prisma, {
    runtimeSessionId: event.sessionId,
    consumer: CONSUMER,
    sourceCursor: event.id,
    generation: sequence > 0n ? sequence : cursor.generation + 1n,
  });
  if (event.sequence != null) {
    await pruneRuntimeLifecycleEvents(prisma, {
      runtimeSessionId: event.sessionId,
      throughSequence: event.sequence,
    });
  }
  return true;
}

type ProjectionInput = {
  config: ServerConfig;
  prisma: PrismaClient;
  runtime: AgentSessionRuntime;
};

/** Reconcile each session independently: one failed remote checkpoint or
 * malformed result must not strand unrelated owners' completed workers. */
export async function drainRuntimeEventProjection(
  input: ProjectionInput,
  delivery: { notify: typeof queueDelegateResult; project: (config: ServerConfig, prisma: PrismaClient, runtime: AgentSessionRuntime, event: AgentRuntimeLifecycleEvent) => Promise<void | boolean> } = { notify: queueDelegateResult, project: projectRuntimeEvent },
  options: { now?: () => number } = {},
): Promise<void> {
  // A busy producer must not keep extending this pass and defer projection
  // indefinitely. Later events belong to the next coalesced drain.
  const latest = await input.prisma.runtimeLifecycleEvent.findFirst({ orderBy: { sequence: "desc" }, select: { sequence: true } });
  if (!latest) return;
  const blocked = new Set<string>();
  // Persist local continuations before any remote projection can prune events.
  for (const stage of ["notify", "project"] as const) {
    let afterSequence = 0;
    while (true) {
      const events = await listRuntimeLifecycleEvents(input.prisma, {
        consumer: stage === "notify" ? NOTIFY_CONSUMER : CONSUMER,
        afterSequence, throughSequence: latest.sequence, take: 100, excludedSessionIds: [...blocked],
        ...(stage === "project" ? { afterConsumer: NOTIFY_CONSUMER } : {}),
      });
      if (!events.length) break;
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (!blocked.has(event.sessionId)) {
          try {
            let acknowledged = true;
            const delivered = await runRuntimeProjectionAttempt(input.prisma, { sessionId: event.sessionId, eventId: event.id, stage }, async () => {
              if (stage === "notify") await delivery.notify(input.prisma, event);
              else acknowledged = await delivery.project(input.config, input.prisma, input.runtime, event) !== false;
            }, options.now);
            if (!delivered || !acknowledged) blocked.add(event.sessionId);
            else await advanceRuntimeEventCursor(input.prisma, { runtimeSessionId: event.sessionId,
              consumer: stage === "notify" ? NOTIFY_CONSUMER : CONSUMER, sourceCursor: event.id, generation: BigInt(event.sequence!) });
          } catch (error) {
            blocked.add(event.sessionId);
            console.error(`[runtime-events] failed ${stage} delivery ${event.id}:`, error);
          }
        }
        // The native SQLite adapter resolves through microtasks. Awaiting SQL
        // alone does not give health requests or provider I/O an event-loop turn.
        if ((index + 1) % 20 === 0) await yieldToRequests();
      }
      afterSequence = events.at(-1)!.sequence!;
      await yieldToRequests();
    }
  }
}

export function startRuntimeEventProjection(input: ProjectionInput, work = async () => {
  await drainRuntimeEventProjection(input);
  await reconcileSourceMessages(input.config, input.prisma, input.runtime);
  await reconcileControlNotices(input.config, input.prisma);
  await projectTaskStalls(input);
}, options: { prepareFinalization?: Parameters<typeof preparationJournalWorker>[1]; confirmFinalization?: Parameters<typeof preparationJournalWorker>[2] } = {}): () => Promise<void> {
  const preparations = preparationJournalWorker(input, options.prepareFinalization, options.confirmFinalization);
  let running: Promise<void> | undefined;
  let requested = false;
  let stopped = false;
  const drain = () => {
    if (stopped) return;
    preparations.tick();
    requested = true;
    if (running) return;
    running = (async () => {
      do {
        requested = false;
        try { await work(); }
        catch (error) { console.error("[runtime-events] journal drain failed:", error); }
        await yieldToRequests();
      } while (requested && !stopped);
    })().finally(() => { running = undefined; });
  };
  const unsubscribe = input.runtime.subscribeAll((event) => {
    if (event.kind === "turn") drain();
  });
  const timer = setInterval(drain, 1_000);
  drain();
  return async () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    await running;
    await preparations.stop();
  };
}
