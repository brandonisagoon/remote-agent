import type { ServerConfig } from "../../../config.ts";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { getMachine } from "../../../machines/index.ts";
import {
  agentIssueDescriptionWithSync,
  agentIssueLabelIdsWithRouting,
  getAgentCatalog,
  getAgentStateId,
  getAgentIssues,
  parseAgentIssueRuntime,
  parseAgentIssueSyncMetadata,
  updateAgentIssue,
} from "../registry/index.ts";
import {
  AgentIssueState,
  isTerminalAgentIssueState,
  type SessionLifecycleEvent,
  type AgentIssueSyncMetadata,
} from "../../../../types/sessions/index.ts";

export async function endWorktreeSessions(
  config: ServerConfig,
  event: Extract<SessionLifecycleEvent, { type: "worktree.ended" }>,
  prisma: PrismaClient,
): Promise<number> {
  const [catalog, candidates] = await Promise.all([
    getAgentCatalog(config),
    getAgentIssues(config, {
      searchTerm: event.locator.worktreePath,
    }),
  ]);
  const machine = getMachine({ id: event.locator.machine });
  const matches = candidates.filter((issue) => {
    const runtime = parseAgentIssueRuntime(issue.description);
    return (
      runtime?.worktreePath === event.locator.worktreePath &&
      issue.labels.nodes.some((label) => label.name === machine.linearLabel) &&
      !isTerminalAgentIssueState(issue.state.name)
    );
  });
  const sync: AgentIssueSyncMetadata = {
    eventId: event.eventId,
    generation: event.generation,
    occurredAt: event.occurredAt,
    cubeIssueIdentifier: null,
  };

  let updated = 0;
  for (const issue of matches) {
    const runtime = parseAgentIssueRuntime(issue.description);
    const record = runtime
      ? await prisma.agentIssueRecord.findUnique({
          where: { harnessSessionId: runtime.harnessSessionId },
        })
      : null;
    const previous = parseAgentIssueSyncMetadata(issue.description);
    const previousGeneration =
      record?.lastGeneration ?? (previous ? BigInt(previous.generation) : null);
    if (previousGeneration && previousGeneration > BigInt(event.generation)) {
      continue;
    }
    await updateAgentIssue(
      config,
      { id: issue.id },
      {
        stateId: getAgentStateId(catalog, {
          name: AgentIssueState.Ended,
        }),
        labelIds: agentIssueLabelIdsWithRouting(catalog, issue, false),
        description: agentIssueDescriptionWithSync(issue.description, sync),
      },
    );
    if (record) {
      await prisma.agentIssueRecord.update({
        where: { harnessSessionId: record.harnessSessionId },
        data: {
          lastEventId: event.eventId,
          lastGeneration: BigInt(event.generation),
        },
      });
    }
    updated += 1;
  }
  return updated;
}
