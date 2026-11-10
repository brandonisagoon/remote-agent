import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { scopeConfig, type ServerConfig } from "../../../../lib/config.ts";
import { getSourceIssueForUpdate } from "../../integrations/linear/session-store/source-issue/read.ts";
import { parseAgentIssueSourceIdentifier } from "../../integrations/linear/session-store/agent-issue/metadata/description.ts";
import { findAgentIssue } from "./lifecycle/agent-issue/queries/index.ts";
import { linkedSourceIssue, NoLinkedSourceIssueError } from "./questions.ts";

/** A retained mirror resolves through its recorded connection and source
 * description. This is a read-only route, never a new task/link assignment. */
export async function issueUpdateSource(input: { prisma: PrismaClient; config: ServerConfig; sessionId: string }): Promise<Awaited<ReturnType<typeof linkedSourceIssue>>> {
  const links = await input.prisma.runtimeSessionResourceLink.count({ where: { runtimeSessionId: input.sessionId, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (links > 1) throw new Error("Source publication has ambiguous issue ownership");
  if (links) return linkedSourceIssue(input);
  const session = await input.prisma.runtimeSession.findUnique({ where: { id: input.sessionId }, include: { sessionMirror: true } });
  const mirror = session?.sessionMirror;
  if (!session || session.status === "closed" || !mirror || mirror.provider !== "linear" || mirror.machineId && mirror.machineId !== session.machineId) throw new NoLinkedSourceIssueError();
  const connectionId = mirror.connectionId === "legacy" ? input.config.activeConnectionId : mirror.connectionId;
  const config = scopeConfig(input.config, { repositoryId: session.repositoryId, connectionId });
  const record = await findAgentIssue(config, { id: mirror.externalId });
  const identifier = record && parseAgentIssueSourceIdentifier(record.description);
  if (!identifier) throw new NoLinkedSourceIssueError();
  const issue = await getSourceIssueForUpdate(config, { id: identifier });
  if (!issue) throw new Error("Retained mirror source issue is missing");
  return { session, config, issue, link: { id: `mirror:${mirror.id}`, runtimeSessionId: session.id, provider: "linear", connectionId, resourceType: "issue-identifier", externalId: identifier, relationship: "handles", createdAt: mirror.createdAt, endedAt: null } };
}
