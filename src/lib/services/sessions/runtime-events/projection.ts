import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../config.ts";
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
} from "../../../../types/runtime/index.ts";
import { AgentIssueState } from "../../../../types/sessions/index.ts";
import type { AgentIssueStateValue, SessionLifecycle } from "../../../../types/sessions/index.ts";
import {
  advanceRuntimeEventCursor,
  getRuntimeEventCursor,
  listRuntimeLifecycleEvents,
  pruneRuntimeLifecycleEvents,
} from "../runtime-registry.ts";
import { findAgentIssue } from "../lifecycle/agent-issue/queries/index.ts";

const CONSUMER = "linear-projection:v1";
const MAX_OUTPUT = 8_000;

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
): Promise<void> {
  const cursor = await getRuntimeEventCursor(prisma, {
    runtimeSessionId: event.sessionId,
    consumer: CONSUMER,
  });
  const sequence = BigInt(event.sequence ?? 0);
  if (
    cursor.sourceCursor === event.id ||
    (sequence > 0n && cursor.generation >= sequence)
  ) return;

  const session = await prisma.runtimeSession.findUnique({
    where: { id: event.sessionId },
    include: { agentIssueRecord: true },
  });
  const record = session?.agentIssueRecord;
  if (!record) return;
  const issue = await findAgentIssue(config, { id: record.agentIssueId });
  if (!issue) return;

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

  if (event.phase === "completed" || event.phase === "failed") {
    const sourceIdentifier = parseAgentIssueSourceIdentifier(issue.description);
    const source = sourceIdentifier
      ? await getSourceIssue(config, { id: sourceIdentifier })
      : null;
    if (source) {
      let rootId = record.sessionRootCommentId;
      if (!rootId) {
        const root = await createThreadedIssueComment(config.linearApiKey, {
          issueId: source.id,
          body: `● Remote Agent session · acpx \`${event.sessionId}\``,
        });
        if (root) {
          rootId = root.id;
          await prisma.agentIssueRecord.update({
            where: { id: record.id },
            data: { sessionRootCommentId: root.id },
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
}

export function startRuntimeEventProjection(input: {
  config: ServerConfig;
  prisma: PrismaClient;
  runtime: AgentSessionRuntime;
}): () => Promise<void> {
  let chain = Promise.resolve();
  let stopped = false;
  const drain = () => {
    chain = chain.then(async () => {
      if (stopped) return;
      for (const event of await listRuntimeLifecycleEvents(input.prisma)) {
        try {
          await projectRuntimeEvent(input.config, input.prisma, input.runtime, event);
        } catch (error) {
          console.error(`[runtime-events] failed to project ${event.id}:`, error);
          break;
        }
      }
    }).catch((error) => {
      console.error("[runtime-events] journal drain failed:", error);
    });
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
    await chain;
  };
}
