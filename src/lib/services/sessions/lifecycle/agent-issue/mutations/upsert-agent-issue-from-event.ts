import type { ServerConfig } from "../../../../../config.ts";
import type { PrismaClient } from "../../../../../../generated/prisma/client.ts";
import {
  agentIssueRuntimeWithLabels,
  buildAgentIssueDescription,
  sourceIssueIdentifierFromBranch,
  parseAgentIssueRuntime,
  parseAgentIssueSyncMetadata,
  parseAgentIssueSourceIdentifier,
  desiredAgentIssueLabelNames,
  mergeAgentIssueLabelIds,
  createAgentIssue,
  createAgentIssueRelation,
  deleteAgentIssueRelation,
  getAgentCatalog,
  getAgentStateId,
  getAgentIssueRelations,
  getAgentIssues,
  getSourceIssue,
  updateAgentIssue,
} from "../../../../../integrations/tracker/index.ts";
import {
  deleteAgentIssueRecord,
  findAgentIssueRecordByHarnessSessionId,
  attachRuntimeSessionToAgentIssue,
  updateAgentIssueRecord,
  upsertAgentIssueRecord,
} from "../../../registry/index.ts";
import {
  AgentIssueState,
  type AgentIssue,
  type AgentIssueSyncMetadata,
  type RuntimeSessionEvent,
} from "../../../../../../types/sessions/index.ts";
import { buildAgentIssueTitle, resolveAgentIssueState } from "../rules/index.ts";
import { enqueueAgentIssueWrite } from "./enqueue-agent-issue-write.ts";
import { findAgentIssue } from "../queries/index.ts";

export async function upsertAgentIssueFromEvent(
  config: ServerConfig,
  event: RuntimeSessionEvent,
  prisma: PrismaClient,
  _dependencies: Record<string, never> = {},
): Promise<AgentIssue | null> {
  return enqueueAgentIssueWrite(event.runtime.harnessSessionId, () =>
    upsertAgentIssue(config, event, prisma),
  );
}

async function upsertAgentIssue(
  config: ServerConfig,
  event: RuntimeSessionEvent,
  prisma: PrismaClient,
): Promise<AgentIssue | null> {
  const catalog = await getAgentCatalog(config);
  let agentIssueRecord = await findAgentIssueRecordByHarnessSessionId(prisma, {
    harnessSessionId: event.runtime.harnessSessionId,
  });
  let existingAgentIssue = agentIssueRecord
    ? await findAgentIssue(config, {
        id: agentIssueRecord.agentIssueId,
      })
    : null;
  if (agentIssueRecord && !existingAgentIssue) {
    await deleteAgentIssueRecord(prisma, {
      harnessSessionId: agentIssueRecord.harnessSessionId,
      agentIssueId: agentIssueRecord.agentIssueId,
    });
    agentIssueRecord = null;
  }

  const matches = existingAgentIssue
    ? [existingAgentIssue]
    : await getAgentIssues(config, {
        harnessSessionId: event.runtime.harnessSessionId,
      });
  if (matches.length > 1) {
    await Promise.allSettled(
      matches.map((issue) =>
        updateAgentIssue(
          config,
          { id: issue.id },
          {
            stateId: getAgentStateId(catalog, {
              name: AgentIssueState.Duplicate,
            }),
          },
        ),
      ),
    );
    throw new Error("multiple Agents issues have the same harness session ID");
  }

  existingAgentIssue = matches[0] ?? null;
  const isRootSession = event.runtime.parentSessionId == null;
  const recordRuntime = {
    harnessSessionId: event.runtime.harnessSessionId,
    machine: isRootSession ? event.runtime.machine : null,
  };
  if (existingAgentIssue && !agentIssueRecord) {
    agentIssueRecord = await upsertAgentIssueRecord(prisma, {
      ...recordRuntime,
      agentIssueId: existingAgentIssue.id,
      agentIssueIdentifier: existingAgentIssue.identifier,
    });
    if (agentIssueRecord.agentIssueId !== existingAgentIssue.id) {
      await updateAgentIssue(
        config,
        { id: existingAgentIssue.id },
        {
          stateId: getAgentStateId(catalog, {
            name: AgentIssueState.Duplicate,
          }),
        },
      );
      existingAgentIssue = await findAgentIssue(config, {
        id: agentIssueRecord.agentIssueId,
      });
      if (!existingAgentIssue) {
        throw new Error("stored Agents issue was not found");
      }
    }
  }

  const previousMetadata = parseAgentIssueSyncMetadata(
    existingAgentIssue?.description ?? null,
  );
  const previousSourceIssueIdentifier = parseAgentIssueSourceIdentifier(
    existingAgentIssue?.description ?? null,
  );
  const storedGeneration = agentIssueRecord?.lastGeneration;
  if (
    (storedGeneration != null &&
      (storedGeneration > BigInt(event.generation) ||
        (storedGeneration === BigInt(event.generation) &&
          agentIssueRecord?.lastEventId === event.eventId))) ||
    (previousMetadata &&
      (previousMetadata.generation > event.generation ||
        (previousMetadata.generation === event.generation &&
          previousMetadata.eventId === event.eventId)))
  ) {
    return existingAgentIssue;
  }

  // Launch registration is authoritative for policy metadata that provider
  // hooks may omit. Preserve it when compatibility hooks emit defaults.
  if (existingAgentIssue) {
    const registered = parseAgentIssueRuntime(existingAgentIssue.description);
    if (registered) {
      event = {
        ...event,
        runtime: {
          ...event.runtime,
          role:
            event.runtime.role === "primary" && registered.role !== "primary"
              ? registered.role
              : event.runtime.role,
          lifecycle: event.runtime.lifecycle ?? registered.lifecycle,
          sourceIssueIdentifier:
            event.runtime.sourceIssueIdentifier ??
            (event.type === "workflow.started" ||
            event.type === "workflow.ended"
              ? null
              : previousSourceIssueIdentifier) ??
            null,
        },
      };
    }
  }

  // A workflow override takes precedence over the branch suffix. Main-worktree
  // workflows detach when workflow.ended omits the override because `main`
  // has no issue suffix; branch-bound workflows retain their existing issue.
  // If runtime.refresh is ever wired to UserPromptSubmit, it must preserve the
  // active override or a main-worktree session will become unroutable between
  // Linear replies.
  const workflowIssueIdentifier =
    event.type === "workflow.started" || event.type === "workflow.ended"
      ? event.sourceIssueIdentifier
      : null;
  const sourceIssueIdentifier =
    workflowIssueIdentifier ??
    event.runtime.sourceIssueIdentifier ??
    sourceIssueIdentifierFromBranch(event.runtime.branchName);
  const sourceIssue = sourceIssueIdentifier
    ? await getSourceIssue(config, { id: sourceIssueIdentifier })
    : null;
  const hasCompleteRuntime =
    Boolean(sourceIssue) && Boolean(event.runtime.runtimeSessionId);
  const stateName = resolveAgentIssueState(
    event,
    hasCompleteRuntime,
    existingAgentIssue,
  );
  const metadata: AgentIssueSyncMetadata = {
    eventId: event.eventId,
    generation: event.generation,
    occurredAt: event.occurredAt,
    sourceIssueIdentifier,
  };
  const data = {
    title: buildAgentIssueTitle(event.runtime, sourceIssueIdentifier),
    description: buildAgentIssueDescription(event.runtime, metadata, config),
    assigneeId: config.agentUserId,
    stateId: getAgentStateId(catalog, { name: stateName }),
    labelIds: mergeAgentIssueLabelIds(
      catalog,
      existingAgentIssue,
      desiredAgentIssueLabelNames(
        event,
        existingAgentIssue,
        stateName === AgentIssueState.Connected,
      ),
    ),
  };

  if (
    existingAgentIssue &&
    previousSourceIssueIdentifier &&
    previousSourceIssueIdentifier !== sourceIssueIdentifier
  ) {
    const relations = await getAgentIssueRelations(config, {
      agentIssueId: existingAgentIssue.id,
    });
    const staleRelations = relations.filter(
      (relation) =>
        relation.type === "related" &&
        relation.sourceIssue.identifier === previousSourceIssueIdentifier,
    );
    await Promise.all(
      staleRelations.map((relation) =>
        deleteAgentIssueRelation(config, { id: relation.id }),
      ),
    );
  }

  let agentIssue: AgentIssue;
  if (existingAgentIssue) {
    agentIssue = await updateAgentIssue(
      config,
      { id: existingAgentIssue.id },
      data,
    );
  } else {
    agentIssue = await createAgentIssue(config, {
      ...data,
      teamId: catalog.teamId,
      stateId: getAgentStateId(catalog, {
        name: AgentIssueState.Registered,
      }),
    });

    agentIssueRecord = await upsertAgentIssueRecord(prisma, {
      ...recordRuntime,
      agentIssueId: agentIssue.id,
      agentIssueIdentifier: agentIssue.identifier,
    });
    if (agentIssueRecord.agentIssueId !== agentIssue.id) {
      await updateAgentIssue(
        config,
        { id: agentIssue.id },
        {
          stateId: getAgentStateId(catalog, {
            name: AgentIssueState.Duplicate,
          }),
        },
      );
      const winner = await findAgentIssue(config, {
        id: agentIssueRecord.agentIssueId,
      });
      if (!winner) {
        throw new Error("stored Agents issue was not found");
      }
      agentIssue = await updateAgentIssue(config, { id: winner.id }, data);
    } else {
      agentIssue = await updateAgentIssue(
        config,
        { id: agentIssue.id },
        {
          stateId: getAgentStateId(catalog, { name: stateName }),
        },
      );
    }
  }

  if (sourceIssue) {
    await createAgentIssueRelation(config, {
      agentIssueId: agentIssue.id,
      sourceIssueId: sourceIssue.id,
      type: "related",
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|duplicate/i.test(message)) throw error;
    });
  }

  const updatedRecord = await updateAgentIssueRecord(prisma, {
    ...recordRuntime,
    lastEventId: event.eventId,
    lastGeneration: event.generation,
  });
  if (isRootSession && event.runtime.runtimeSessionId) {
    await attachRuntimeSessionToAgentIssue(prisma, {
      runtimeSessionId: event.runtime.runtimeSessionId,
      agentIssueRecordId: updatedRecord.id,
    });
  }

  return agentIssue;
}
