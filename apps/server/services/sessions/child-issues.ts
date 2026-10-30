import { workMapProjection, assertMappedIssueDelivery } from "./work-map.ts";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import { getIssueWorkGraph } from "../../integrations/linear/session-store/source-issue/work-graph.ts";
import { linkedSourceIssue } from "./questions.ts";
import { IssueUpdateInput, issueUpdateDelivery, publishSessionIssueUpdate } from "./issue-updates.ts";
import { assertTaskOpen } from "../tasks/task-state.ts";
import { taskForSession } from "../tasks/store.ts";

type Context = { prisma: PrismaClient; config: ServerConfig; sessionId: string };
const graphDelivery = { source: linkedSourceIssue, graph: getIssueWorkGraph };

async function assertPrimary(input: Context) {
  const session = await input.prisma.runtimeSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  const task = await taskForSession(input.prisma, input.sessionId);
  if (session.status === "closed" || session.role !== "primary" || !task || task.primarySessionId !== session.id
    || session.cwd !== task.worktreePath || session.repositoryId !== task.repositoryId
    || session.machineId !== task.machineId || task.machineId !== input.config.machine) throw new Error("Only the owning task primary may manage child issues");
  await assertTaskOpen(input.prisma, session.cwd);
  return session;
}

export async function readSessionWorkGraph(input: Context, client = graphDelivery) {
  await assertPrimary(input);
  const source = await client.source(input);
  const graph = await client.graph(source.config, { id: source.issue.id });
  await assertPrimary(input);
  // Bind reply ownership to the same primary, never create child sessions.
  for (const child of graph.children) {
    const identity = { runtimeSessionId: input.sessionId, provider: "linear", connectionId: source.link.connectionId, resourceType: "issue-identifier", externalId: child.identifier, relationship: "child" };
    await input.prisma.runtimeSessionResourceLink.upsert({ where: { runtimeSessionId_provider_connectionId_resourceType_externalId_relationship: identity }, create: identity, update: { endedAt: null } });
  }
  return { ...graph, ...await workMapProjection(input, graph) };
}

export const ChildIssueUpdateInput = IssueUpdateInput.safeExtend({ childIssueId: z.string().trim().min(1).max(200) });

/** Reuse the parent's durable evidence/comment/state transaction, but prove
 * direct membership on every state check so reparenting revokes access. */
export async function publishChildIssueUpdate(input: Context & z.infer<typeof ChildIssueUpdateInput>, client = issueUpdateDelivery) {
  await assertPrimary(input);
  const parent = await client.source(input);
  const readChild = async (config: ServerConfig, query: { id: string }) => {
    await assertPrimary(input);
    const graph = await client.graph(parent.config, { id: parent.issue.id });
    const child = graph.children.find((item) => item.id === input.childIssueId || item.identifier === input.childIssueId);
    if (!child || (query.id !== child.id && query.id !== child.identifier)) throw new Error("Target is not a current direct child of this task's source issue");
    const issue = await client.read(config, { id: child.id });
    if (!issue) throw new Error("Child issue no longer exists");
    const target = issue.team.states.nodes.find((state) => state.name === input.state);
    if (target && (target.type === "started" || target.type === "completed") && target.name !== "Blocked") {
      for (const prerequisite of child.blockedBy) {
        const dependency = graph.children.find((item) => item.id === prerequisite) ?? await client.read(config, { id: prerequisite });
        if (!dependency || !["completed", "canceled"].includes(dependency.state.type)) throw new Error(`Child prerequisite ${dependency?.identifier ?? prerequisite} is not complete`);
      }
    }
    if (target?.type === "completed" && target.name !== "Manual Review") await assertMappedIssueDelivery(input, graph, child.id);
    return issue;
  };
  const child = await readChild(parent.config, { id: input.childIssueId });
  const identity = { runtimeSessionId: input.sessionId, provider: "linear", connectionId: parent.link.connectionId, resourceType: "issue-identifier", externalId: child.identifier, relationship: "child" };
  await input.prisma.runtimeSessionResourceLink.upsert({ where: { runtimeSessionId_provider_connectionId_resourceType_externalId_relationship: identity }, create: identity, update: { endedAt: null } });
  // A child is an acceptance unit, not a second shipping task. The parent's
  // delivery contract still gates the final source-issue completion.
  return publishSessionIssueUpdate(input, { ...client, source: async () => ({ ...parent, issue: child }), read: readChild, complete: async () => {} });
}
