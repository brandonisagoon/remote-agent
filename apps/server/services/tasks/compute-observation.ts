import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { ComputeRoute, trafficSummary, type TrafficState } from "../../../../lib/compute-telemetry.ts";
import { ComputeDecisionEvidence } from "./compute-decision.ts";
import { finalizationDigest, finalizationResourceIdentity } from "./finalization-resources.ts";
import { assertSavedComputeObservation, isSavedComputeEnvironment } from "./compute-saved-resource.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.string().min(1).max(256);
export const ComputeObservation = z.object({ version: z.literal(1), environmentId: Identity,
  taskId: Identity, primarySessionId: Identity, purpose: z.enum(["development", "review"]), revision: z.string().regex(/^[a-f0-9]{40}$/),
  recipeDigest: Digest, resourceId: Identity, resourceIdentity: Digest,
  observedAt: z.number().int().nonnegative(), state: z.enum(["running", "stopped", "absent", "unknown"]),
  coverage: z.enum(["complete", "incomplete"]), configurationDigest: Digest,
  // Every declared request listener and independent work source must be in the
  // observed configuration. Empty or missing job coverage is not idle.
  routes: z.array(ComputeRoute).max(32),
  operations: z.object({ coverage: z.enum(["complete", "incomplete"]), active: z.number().int().nonnegative(), generation: Digest }).strict(),
}).strict();
export type ComputeObservation = z.infer<typeof ComputeObservation>;
type Store = Pick<Prisma.TransactionClient, "computeEnvironment" | "computeTraffic" | "remoteTask" | "remoteTaskResource" | "runtimeSession" | "runtimeSessionResourceLink" | "runtimeInstruction" | "runtimeLifecycleEvent" | "runtimeMetadataEvent">;
type Context = { prisma: Store; config: ServerConfig; environmentId: string; now?: Date };
const stamp = (input: Context) => input.now?.getTime() ?? Date.now();

/** Called only with a result of the configured immutable read-only observer.
 * No HTTP endpoint accepts client-supplied proof/paths/coverage booleans. */
export async function recordComputeObservation(input: Context & { observation: ComputeObservation }) {
  const value = ComputeObservation.parse(input.observation);
  const env = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  if (isSavedComputeEnvironment(env)) assertSavedComputeObservation(env, value);
  await (await import("./compute-admission.ts")).assertComputeEnvironmentOwner(input.prisma, env);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: env.taskId } });
  const resource = await input.prisma.remoteTaskResource.findUnique({ where: { id: value.resourceId } });
  if (!resource || resource.taskId !== env.taskId || resource.purpose !== env.purpose || resource.state === "released" || task.primarySessionId !== env.primarySessionId
    || value.environmentId !== env.id || value.taskId !== env.taskId || value.primarySessionId !== env.primarySessionId || value.purpose !== env.purpose || value.revision !== env.revision
    || value.recipeDigest !== env.recipeDigest || finalizationResourceIdentity(resource).identityDigest !== value.resourceIdentity
    || value.observedAt > stamp(input) + 1000 || stamp(input) - value.observedAt > 10_000) throw new Error("Compute observation ownership or freshness changed");
  if (value.routes.some(route => route.environmentId !== env.id || route.taskId !== env.taskId || route.primarySessionId !== env.primarySessionId || route.purpose !== env.purpose
    || route.revision !== env.revision || route.resourceId !== resource.id || route.resourceIdentity !== value.resourceIdentity || route.configurationDigest !== value.configurationDigest)
    || new Set(value.routes.map(route => route.id)).size !== value.routes.length) throw new Error("Compute route coverage ownership changed");
  await input.prisma.computeEnvironment.update({ where: { id: env.id }, data: { resourceId: resource.id, resourceIdentity: value.resourceIdentity, observation: value } });
  return value;
}

/** Conversation collection is bounded and strips credential-shaped lines,
 * tool payloads, URLs and code blocks before classification. Original logs are
 * neither rewritten nor copied into the persisted decision. */
export function sanitizeComputeConversation(messages: { role: "user" | "agent"; text: string }[], secrets: string[] = []) {
  return messages.slice(-32).flatMap(message => {
    if (secrets.some(value => value.length > 16_384)) return [];
    let text = message.text.slice(0, 32_000);
    for (const secret of secrets.filter(value => value.length >= 8)) text = text.split(secret).join("[credential omitted]");
    text = text.replace(/```[\s\S]*?(?:```|$)/g, "[code omitted]")
      .split(/\r?\n/).map(line => /(?:authorization|bearer|password|secret|token|api[_ -]?key|private[_ -]?key|cookie|DATABASE_URL|postgres(?:ql)?:\/\/)/i.test(line) ? "[private configuration omitted]" : line)
      .join("\n").replace(/https?:\/\/[^\s<>]+/g, "[URL omitted]").replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|pk)_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g, "[credential omitted]").slice(0, 4000).trim();
    return text ? [{ role: message.role === "agent" ? "assistant" as const : "user" as const, text }] : [];
  });
}

export async function computeEvidenceState(input: Context & { allowStopped?: boolean }) {
  const env = await input.prisma.computeEnvironment.findUniqueOrThrow({ where: { id: input.environmentId } });
  await (await import("./compute-admission.ts")).assertComputeEnvironmentOwner(input.prisma, env);
  const task = await input.prisma.remoteTask.findUniqueOrThrow({ where: { id: env.taskId } });
  const primary = task.primarySessionId && await input.prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } });
  if (!primary || primary.id !== env.primarySessionId || primary.role !== "primary" || primary.closedAt || primary.status === "closed" || primary.cwd !== task.worktreePath
    || primary.machineId !== task.machineId || primary.repositoryId !== task.repositoryId || task.machineId !== input.config.machine || env.machineId !== task.machineId) throw new Error("Compute observation original ownership changed");
  if (task.issueIdentifier && (!task.connectionId || !(await input.prisma.runtimeSessionResourceLink.findFirst({ where: { runtimeSessionId: primary.id, provider: "linear", connectionId: task.connectionId, resourceType: "issue-identifier", externalId: task.issueIdentifier, relationship: "handles", endedAt: null } })))) throw new Error("Compute source ownership was revoked");
  if (!env.observation) throw new Error("No current owned compute observation");
  const observation = ComputeObservation.parse(env.observation);
  const resources = await input.prisma.remoteTaskResource.findMany({ where: { taskId: task.id }, take: 1001 });
  if (resources.length > 1000) throw new Error("Compute inventory exceeds its bound");
  const resource = resources.find(resource => resource.id === observation.resourceId);
  if (!resource || resource.state === "released" || finalizationResourceIdentity(resource).identityDigest !== observation.resourceIdentity || observation.recipeDigest !== env.recipeDigest
    || observation.revision !== env.revision || observation.purpose !== env.purpose || observation.taskId !== task.id || observation.primarySessionId !== primary.id || observation.environmentId !== env.id) throw new Error("Compute observation resource identity changed");
  const sessions = await input.prisma.runtimeSession.findMany({ where: { cwd: task.worktreePath! }, take: 1001 });
  if (sessions.length > 1000 || sessions.some(session => session.repositoryId !== task.repositoryId || session.machineId !== task.machineId)) throw new Error("Compute session ownership is ambiguous");
  const instructions = await input.prisma.runtimeInstruction.findMany({ where: { sessionId: { in: sessions.map(session => session.id) } }, orderBy: { sequence: "desc" }, take: 1001 });
  const pending = await input.prisma.runtimeInstruction.count({ where: { sessionId: { in: sessions.map(session => session.id) }, state: { in: ["queued", "preparing", "dispatching", "unknown"] } } });
  const lifecycle = await input.prisma.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: sessions.map(session => session.id) } }, orderBy: { sequence: "desc" }, take: 1001 });
  const rows = await input.prisma.computeTraffic.findMany({ where: { environmentId: env.id }, take: 33 });
  const policy = input.config.compute; if (!policy?.enabled) throw new Error("Host compute admission is disabled");
  const now = stamp(input), freshness = policy.collectorFreshnessSeconds * 1000, quiet = policy.quietPeriodSeconds * 1000;
  const summaries = rows.map(row => trafficSummary(row.state as TrafficState, now, freshness, quiet));
  const routeSet = observation.routes.map(route => finalizationDigest(route)).sort();
  const stopped = input.allowStopped === true && observation.state === "stopped";
  const covered = rows.length > 0 && rows.length <= 32 && observation.coverage === "complete" && finalizationDigest(routeSet) === finalizationDigest(summaries.map(summary => finalizationDigest(summary.route)).sort())
    && (stopped || summaries.every(summary => summary.coverage === "complete")) && now >= observation.observedAt && now - observation.observedAt <= freshness;
  const unmatchedStart = sessions.some(session => lifecycle.find(event => event.runtimeSessionId === session.id)?.phase === "started" && !session.closedAt);
  const settled = !unmatchedStart && sessions.every(session => session.closedAt || ["idle", "closed"].includes(session.status)) && pending === 0;
  const operationsComplete = observation.operations.coverage === "complete" && observation.operations.active === 0;
  const reviewProtected = env.purpose === "review" || resources.some(resource => resource.purpose === "review" && resource.state !== "released" && (!resource.expiresAt || resource.expiresAt.getTime() > now));
  const eligible = covered && settled && operationsComplete && !task.ownerPaused && !["complete", "closed"].includes(task.phase) && !reviewProtected && (observation.state === "running" || stopped) && (stopped || summaries.every(summary => summary.candidate));
  const last = (key: "lastMeaningfulAt" | "lastUnknownAt") => { const values = summaries.map(value => value[key]).filter((value): value is number => value !== null); return values.length ? Math.max(...values) : null; };
  // Heartbeats refresh evidence, but do not supersede an otherwise identical
  // decision. Activity, coverage generation, ownership and identity do.
  const snapshotDigest = finalizationDigest({ task: { id: task.id, primarySessionId: task.primarySessionId, machineId: task.machineId, repositoryId: task.repositoryId, worktreePath: task.worktreePath, toolingRevision: task.toolingRevision, pinnedToolingRoot: task.pinnedToolingRoot, ownerPaused: task.ownerPaused, phase: task.phase },
    observation: { ...observation, observedAt: undefined, state: ["running", "stopped"].includes(observation.state) ? "saved-compute" : observation.state }, resources: resources.map(value => ({ ...finalizationResourceIdentity(value), state: value.id === resource.id && ["ready", "allocated"].includes(value.state) ? "retained" : value.state })).sort((a,b) => a.key.localeCompare(b.key)),
    sessions: sessions.map(value => ({ id: value.id, status: value.status, closedAt: value.closedAt })), instructions: instructions.map(value => ({ id: value.id, state: value.state, updatedAt: value.updatedAt })),
    lifecycle: lifecycle.map(value => ({ sequence: value.sequence, phase: value.phase, requestId: value.requestId })),
    traffic: summaries.map(value => ({ route: value.route, epoch: value.epoch, coverage: stopped ? "complete" : value.coverage, coverageSince: value.coverageSince, lastMeaningfulAt: value.lastMeaningfulAt, lastUnknownAt: value.lastUnknownAt, inFlight: value.inFlight, activeStreams: value.activeStreams })).sort((a,b) => a.route.id.localeCompare(b.route.id)) });
  const evidence = ComputeDecisionEvidence.parse({ version: 1, task: { id: task.id, primarySessionId: primary.id, environmentId: env.id, purpose: env.purpose, revision: env.revision }, observedAt: now, evidenceDigest: snapshotDigest,
    traffic: { coverage: covered ? "complete" : "incomplete", lastMeaningfulAt: last("lastMeaningfulAt"), lastUnknownAt: last("lastUnknownAt"), inFlight: summaries.reduce((sum,value) => sum+value.inFlight,0), activeStreams: summaries.reduce((sum,value) => sum+value.activeStreams,0), quietForMs: summaries.length ? Math.max(0, Math.min(...summaries.map(value => now - Math.max(value.coverageSince, value.lastMeaningfulAt ?? 0, value.lastUnknownAt ?? 0)))) : 0, collectorAgeMs: Math.max(0, now - Math.min(observation.observedAt, ...summaries.map(value => value.observedAt))) },
    activity: { ownedSessionsSettled: settled, operationsComplete, pendingInstructions: pending, ownerPaused: task.ownerPaused, reviewProtected, latestInstructionAt: instructions.length ? Math.max(...instructions.map(value => value.createdAt.getTime())) : null }, conversation: [] });
  return { evidence, snapshotDigest, eligible, physicalState: observation.state, sessionIds: sessions.filter(value => !value.closedAt && value.status !== "closed").map(value => value.id), resource: { id: resource.id, key: resource.key, identityDigest: observation.resourceIdentity } };
}
export async function collectComputeEvidence(input: Context & { runtime: Pick<AgentSessionRuntime, "history" | "observeSessionActivity"> }) {
  const result = await computeEvidenceState(input);
  const observedBusy = result.sessionIds.some(id => ["executing", "queued"].includes(input.runtime.observeSessionActivity?.(id)?.state ?? ""));
  if (observedBusy) { result.eligible = false; result.evidence.activity.ownedSessionsSettled = false; }
  const history = sanitizeComputeConversation(await input.runtime.history(result.evidence.task.primarySessionId), [input.config.compute?.decisionApiKey, input.config.apiKey, input.config.webhookSecret, ...Object.values(input.config.webhooks).map(value => value.webhookSecret), ...Object.values(input.config.connections).map(value => typeof value.apiKey === "string" ? value.apiKey : value.apiKey.clientSecret)].filter((value): value is string => Boolean(value)));
  const fresh = await computeEvidenceState(input);
  if (fresh.snapshotDigest !== result.snapshotDigest) throw new Error("Compute evidence changed while reading conversation");
  const stillBusy = fresh.sessionIds.some(id => ["executing", "queued"].includes(input.runtime.observeSessionActivity?.(id)?.state ?? ""));
  return { ...fresh, eligible: fresh.eligible && !observedBusy && !stillBusy, evidence: { ...fresh.evidence, activity: { ...fresh.evidence.activity, ownedSessionsSettled: fresh.evidence.activity.ownedSessionsSettled && !observedBusy && !stillBusy }, conversation: history } };
}
export async function assertComputeEvidence(input: Context & { snapshotDigest: string; allowStopped?: boolean }) {
  const current = await computeEvidenceState(input);
  if (!current.eligible || current.snapshotDigest !== input.snapshotDigest) throw new Error("Compute inactivity evidence changed or is incomplete");
  return current;
}

export async function refreshComputeObservation(input: { prisma: PrismaClient; config: ServerConfig; environmentId: string }) {
  return (await import("./compute-observer.ts")).refreshComputeObservation(input);
}

export async function computeEvidenceMatches(input: Context & { snapshotDigest: string; allowStopped?: boolean }) {
  const current = await computeEvidenceState(input);
  return current.eligible && current.snapshotDigest === input.snapshotDigest;
}
