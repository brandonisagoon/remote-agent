import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../config.ts";
import { getMachine } from "../../../machines/index.ts";
import { getSourceIssueForRouting } from "../../../integrations/linear/session-store/source-issue/read.ts";
import type {
  TrackerRoutingContext,
  RouteCandidate,
  SessionRole,
} from "../../../../types/sessions/index.ts";
import { AgentIssueState } from "../../../../types/sessions/index.ts";

function role(value: string | null): SessionRole | null {
  return value === "primary" ||
      value === "delegate" ||
      value === "viewer" ||
      value === "unassigned"
    ? value
    : null;
}

function trackerState(status: string): RouteCandidate["status"] {
  if (status === "idle" || status === "active") return AgentIssueState.Connected;
  if (status === "closed") return AgentIssueState.Ended;
  if (status === "error") return AgentIssueState.Error;
  return AgentIssueState.Disconnected;
}

export async function fetchRouteCandidates(
  config: ServerConfig,
  prisma: PrismaClient,
  sourceIssueIdentifier: string,
): Promise<RouteCandidate[]> {
  const repository = config.repository;
  const visibleKeys = new Set(
    Object.entries(repository.metadata.tags)
      .filter(([, definition]) => definition.routerVisible)
      .map(([key]) => key),
  );
  const links = await prisma.runtimeSessionResourceLink.findMany({
    where: {
      provider: "linear",
      connectionId: config.activeConnectionId,
      resourceType: "issue-identifier",
      externalId: sourceIssueIdentifier,
      relationship: "handles",
      endedAt: null,
      runtimeSession: { repositoryId: repository.id },
    },
    include: {
      runtimeSession: { include: { tags: true } },
    },
  });
  const unique = new Map(
    links.map((link) => [link.runtimeSession.id, link.runtimeSession]),
  );
  return [...unique.values()].flatMap((session) => {
    const sessionRole = role(session.role);
    if (!sessionRole || !session.worktreePath) return [];
    try {
      getMachine({ id: session.machineId });
    } catch {
      return [];
    }
    return [{
      // These compatibility names remain until the public worker result shape
      // is renamed; both values are stable RuntimeSession IDs, not Linear
      // Agent-team issue identities.
      agentIssueId: session.id,
      agentIssueIdentifier: session.id,
      status: trackerState(session.status),
      assigneeId: null,
      labels: session.tags
        .filter((tag) => visibleKeys.has(tag.key))
        .map((tag) => `${tag.key}:${tag.value}`)
        .sort(),
      runtime: {
        harnessSessionId: session.id,
        parentSessionId: null,
        worktreePath: session.worktreePath,
        branchName: null,
        harness: session.agentCommand === "claude" ? "claude" : "codex",
        machine: session.machineId,
        role: sessionRole,
        lifecycle: null,
        sourceIssueIdentifier,
        runtimeSessionId: session.id,
      },
    }];
  });
}

export async function fetchTrackerRoutingContext(
  config: ServerConfig,
  prisma: PrismaClient,
  sourceIssueIdentifier: string,
): Promise<TrackerRoutingContext | null> {
  const [sourceIssue, candidates] = await Promise.all([
    getSourceIssueForRouting(config, { id: sourceIssueIdentifier }),
    fetchRouteCandidates(config, prisma, sourceIssueIdentifier),
  ]);
  if (!sourceIssue) return null;
  return {
    sourceIssue: {
      identifier: sourceIssue.identifier,
      title: sourceIssue.title,
      description: sourceIssue.description,
      status: sourceIssue.state.name,
      labels: sourceIssue.labels.nodes.map((label) => label.name),
    },
    candidates,
  };
}

export function isEligibleCandidate(
  _config: ServerConfig,
  candidate: RouteCandidate,
): boolean {
  const machine = getMachine({ id: candidate.runtime.machine });
  return (
    candidate.status === AgentIssueState.Connected &&
    machine.acceptsTrackerInput &&
    candidate.runtime.role === "primary" &&
    Boolean(candidate.runtime.runtimeSessionId)
  );
}
