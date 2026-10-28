import type { PrismaClient, RemoteTask, RuntimeInstruction, RuntimeLifecycleEvent, RuntimeQuestion, RuntimeSession } from "../../../../generated/prisma/client.ts";
import type { AgentSessionRuntime } from "../../../../types/runtime/index.ts";
import { z } from "zod";
import { listRuntimeProjectionRetries } from "../sessions/runtime-events/projection-retries.ts";

type Task = Pick<RemoteTask, "id" | "phase" | "controlMode" | "recoveryDetail">;
type Session = Pick<RuntimeSession, "id" | "status" | "closedAt" | "recoveryDetail">;
type Instruction = Pick<RuntimeInstruction, "id" | "state" | "detail" | "createdAt" | "updatedAt" | "sequence">;
type Turn = Pick<RuntimeLifecycleEvent, "id" | "requestId" | "phase" | "occurredAt" | "sequence">;
type Question = Pick<RuntimeQuestion, "id" | "state" | "createdAt" | "updatedAt">;
type Observation = { state: "executing" | "queued" | "unknown"; observedAt: number; requestId?: string };
type ActivityState = "executing" | "queued" | "waiting-owner" | "waiting-active-work" | "waiting-dependency" | "stalled" | "unknown" | "paused" | "closed" | "idle";
const unsettledStates = ["preparing", "queued", "dispatching", "unknown"];
const PublishedIdentity = z.object({ connectionId: z.string(), issueId: z.string(), issueIdentifier: z.string(), state: z.string().nullable() });

async function sourceReviewHandoff(prisma: PrismaClient, task: RemoteTask, session: RuntimeSession | null) {
  if (!session || session.role === "delegate" || !task.connectionId || !task.issueIdentifier) return null;
  const links = await prisma.runtimeSessionResourceLink.findMany({ where: { runtimeSessionId: session.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null } });
  if (links.length !== 1 || links[0]!.connectionId !== task.connectionId || links[0]!.externalId !== task.issueIdentifier) return null;
  const events = await prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: session.id, action: "issue-update-published", source: "issue-update-observer" }, orderBy: { sequence: "desc" } });
  for (const event of events) {
    let value: unknown;
    try { value = JSON.parse(event.value ?? "null"); } catch { continue; }
    const parsed = PublishedIdentity.safeParse(value);
    if (!parsed.success) continue;
    const identity = parsed.data;
    if (identity.connectionId !== task.connectionId || identity.issueIdentifier !== task.issueIdentifier) continue;
    // A later source state publication supersedes review. Comment-only updates
    // do not. Legacy unbound receipts cannot establish source-vs-child identity.
    if (!identity.state) continue;
    if (identity.state !== "Manual Review") return null;
    const receipt = await prisma.runtimeIssueUpdate.findFirst({ where: { id: event.key ?? "", runtimeSessionId: session.id, connectionId: identity.connectionId, issueId: identity.issueId, published: true, commentPosted: true } });
    const payload = z.object({ state: z.literal("Manual Review") }).safeParse(receipt?.input);
    if (!receipt || !payload.success) return null;
    // Include an owner decision racing publication acknowledgement: a Merge
    // recorded after this update began must not be hidden by a later receipt.
    const decisions = await prisma.runtimeMetadataEvent.findMany({ where: { runtimeSessionId: session.id, source: `owner:${task.id}`, action: "completion-contract", occurredAt: { gte: receipt.createdAt } } });
    for (const decision of decisions) {
      try { if (JSON.parse(decision.value ?? "null")?.boundary === "merge") return null; } catch { /* malformed legacy metadata grants no authority */ }
    }
    return { receiptId: receipt.id, issueIdentifier: identity.issueIdentifier, issueId: identity.issueId, publishedAt: event.occurredAt.toISOString(), since: event.occurredAt };
  }
  return null;
}

function timing(since: Date | null, now: number) {
  return { since: since?.toISOString() ?? null, durationMs: since ? Math.max(0, now - since.getTime()) : null };
}

/** Runtime liveness is a point-in-time observation, never inferred from the
 * durable status flag. Durations refer only to timestamped evidence; absent
 * state-transition timestamps remain null rather than inventing start times. */
export function deriveSessionActivity(input: {
  task: Task; session: Session | null; pending: Instruction[]; questions: Question[];
  latestTurn: Turn | null; observation?: Observation | null; now: number;
}) {
  const { task, session, pending, questions, latestTurn, now } = input;
  const oldest = (state: string) => pending.filter((item) => item.state === state).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())[0];
  const queued = oldest("queued"), unknown = oldest("unknown"), dispatching = oldest("dispatching"), preparing = oldest("preparing");
  const unanswered = questions.filter((question) => question.state === "pending" || question.state === "posted" || question.state === "unknown");
  const question = unanswered[0];
  const observation = input.observation ?? { state: "unknown" as const, observedAt: now };
  let state: ActivityState = "idle", cause = "No queued instruction or active turn is confirmed", since: Date | null = null;
  if (task.phase === "closed" || session?.status === "closed") {
    state = "closed"; cause = "Task or session is closed"; since = session?.closedAt ?? null;
  } else if (observation.state === "executing") {
    state = "executing"; cause = "The current daemon observes an active provider turn";
    if (observation.requestId === latestTurn?.requestId && latestTurn?.phase === "started") since = latestTurn.occurredAt;
  } else if (task.controlMode !== "agent") {
    state = "paused"; cause = `Task automation is ${task.controlMode}`;
  } else if (unknown) {
    state = "stalled"; cause = unknown.detail ?? "Instruction delivery has no confirmed outcome; explicit resolution is required"; since = unknown.updatedAt;
  } else if (observation.state === "queued") {
    state = "queued"; cause = "The current daemon observes a turn waiting to start; capacity or session queue cause is not confirmed"; since = queued?.updatedAt ?? null;
  } else if (dispatching || preparing) {
    state = "unknown"; cause = dispatching ? "Instruction was claimed, but current execution is unconfirmed" : "Instruction preparation is recorded; current execution is unconfirmed";
    since = (dispatching ?? preparing)!.updatedAt;
  } else if (queued) {
    state = "queued"; cause = "Instruction is accepted but has not been dispatched"; since = queued.updatedAt;
  } else if (question) {
    state = question.state === "unknown" ? "stalled" : "waiting-owner";
    cause = question.state === "unknown" ? "Owner question delivery is unconfirmed" : "An unanswered owner question is recorded";
    since = question.updatedAt;
  } else if (!session || session.status === "active" || session.status === "provisioning" || session.status === "error") {
    state = "unknown"; cause = session?.recoveryDetail ?? "Persisted session status does not establish current provider liveness";
  }
  return {
    state: state as ActivityState, cause, observedAt: new Date(now).toISOString(), ...timing(since, now),
    correlation: { taskId: task.id, sessionId: session?.id ?? null, instructionId: (unknown ?? dispatching ?? preparing ?? queued)?.id ?? null, requestId: observation.requestId ?? null },
    execution: { ...observation, observedAt: new Date(observation.observedAt).toISOString(), persistedStatus: session?.status ?? null },
    control: { mode: task.controlMode, reportedPhase: task.phase, reportedDetail: task.recoveryDetail },
    delivery: {
      counts: Object.fromEntries(unsettledStates.map((value) => [value, pending.filter((item) => item.state === value).length])),
      // Include oldest receipts even when the recent-history page is full.
      pending: pending.slice(0, 100).map((item) => ({ id: item.id, state: item.state, detail: item.detail, ...timing(item.updatedAt, now), acceptedAt: item.createdAt.toISOString() })),
      truncated: pending.length > 100,
    },
    ownerQuestions: unanswered.map((item) => ({ id: item.id, state: item.state, ...timing(item.updatedAt, now) })),
    latestTurn: latestTurn ? { eventId: latestTurn.id, requestId: latestTurn.requestId, phase: latestTurn.phase, occurredAt: latestTurn.occurredAt.toISOString(), ageMs: Math.max(0, now - latestTurn.occurredAt.getTime()) } : null,
  };
}

type PendingResult = {
  sessionId: string; eventId: string; requestId: string; phase: string; instructionId: string;
  deliveryState: string; cause: string; since: string; durationMs: number;
};

/** Read-only snapshot. The caller retains its authenticated task route; session
 * content is additionally confined to this task's worktree/repo/machine and
 * direct spawned-by relations. This function never reconciles or starts work. */
export async function readTaskActivity(prisma: PrismaClient, runtime: AgentSessionRuntime, taskId: string, now = Date.now()) {
  const task = await prisma.remoteTask.findUnique({ where: { id: taskId }, include: { resources: true } });
  if (!task) return null;
  const owned = (row: RuntimeSession) => row.repositoryId === task.repositoryId && row.machineId === task.machineId && row.cwd === task.worktreePath;
  const primary = task.primarySessionId ? await prisma.runtimeSession.findUnique({ where: { id: task.primarySessionId } }) : null;
  const primarySession = primary && owned(primary) ? primary : null;
  const children = primarySession && task.worktreePath ? await prisma.runtimeSession.findMany({ where: {
    role: "delegate", cwd: task.worktreePath, repositoryId: task.repositoryId, machineId: task.machineId,
    outgoingRelations: { some: { targetSessionId: primarySession.id, relationship: "spawned-by", endedAt: null } },
  }, orderBy: { createdAt: "asc" } }) : [];

  const snapshot = async (row: RuntimeSession | null) => {
    const readErrors: string[] = [];
    const [session, history, questions, instructions, pending, latestTurn] = row ? await Promise.all([
      runtime.getSession(row.id).catch(() => { readErrors.push("Runtime session lookup is unavailable"); return null; }),
      runtime.history(row.id).catch(() => { readErrors.push("Session history is unavailable"); return []; }),
      prisma.runtimeQuestion.findMany({ where: { runtimeSessionId: row.id }, orderBy: { createdAt: "asc" } }),
      prisma.runtimeInstruction.findMany({ where: { sessionId: row.id }, orderBy: { sequence: "desc" }, take: 100 }),
      prisma.runtimeInstruction.findMany({ where: { sessionId: row.id, state: { in: unsettledStates } }, orderBy: { sequence: "asc" }, select: { id: true, sequence: true, state: true, detail: true, createdAt: true, updatedAt: true } }),
      prisma.runtimeLifecycleEvent.findFirst({ where: { runtimeSessionId: row.id }, orderBy: { sequence: "desc" }, select: { id: true, requestId: true, phase: true, occurredAt: true, sequence: true } }),
    ]) : [null, [], [], [], [], null];
    let observation: Observation | null = null;
    if (row && runtime.observeSessionActivity) {
      try { observation = runtime.observeSessionActivity(row.id); } catch { readErrors.push("Runtime execution observation is unavailable"); }
    }
    const activity = { ...deriveSessionActivity({ task, session: row, pending, questions, latestTurn, observation, now }), readErrors };
    if (row && !session && activity.state === "idle") {
      activity.state = "unknown"; activity.cause = "Persisted session exists, but the runtime session is unavailable";
    }
    return { session, history, questions, instructions, activity };
  };
  const [main, delegates, notifications] = await Promise.all([
    snapshot(primarySession), Promise.all(children.map(snapshot)),
    primarySession ? prisma.runtimeSessionRelation.findMany({ where: { targetSessionId: primarySession.id, sourceSessionId: { in: children.map((child) => child.id) }, relationship: "notifies-parent", endedAt: null } }) : [],
  ]);
  const pendingDelegateResults: PendingResult[] = [];
  if (primarySession && notifications.length) {
    const [events, receipts] = await Promise.all([
      prisma.runtimeLifecycleEvent.findMany({ where: { runtimeSessionId: { in: notifications.map((link) => link.sourceSessionId) }, phase: { in: ["completed", "failed", "cancelled"] } }, orderBy: { sequence: "asc" }, select: { runtimeSessionId: true, id: true, requestId: true, phase: true, occurredAt: true } }),
      prisma.runtimeInstruction.findMany({ where: { sessionId: primarySession.id, id: { startsWith: `delegate-result:${primarySession.id}:` } }, select: { id: true, state: true, detail: true } }),
    ]);
    const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
    for (const event of events) {
      const instructionId = `delegate-result:${primarySession.id}:${event.id}`;
      const receipt = byId.get(instructionId);
      // completed means the parent's delivery turn ended successfully, not that
      // the task succeeded; acknowledged/cancelled are supervisor decisions.
      if (receipt && ["completed", "acknowledged", "cancelled"].includes(receipt.state)) continue;
      if (!receipt && primarySession.status === "closed") continue;
      pendingDelegateResults.push({
        sessionId: event.runtimeSessionId, eventId: event.id, requestId: event.requestId, phase: event.phase, instructionId,
        deliveryState: receipt?.state ?? "not-enqueued", cause: receipt?.detail ?? (receipt ? "Terminal result has not completed delivery to the primary" : "Terminal result is journaled but has no primary inbox receipt"),
        since: event.occurredAt.toISOString(), durationMs: Math.max(0, now - event.occurredAt.getTime()),
      });
    }
  }
  const projectionRetries = primarySession ? await listRuntimeProjectionRetries(prisma, [primarySession.id, ...children.map((child) => child.id)]) : [];
  const reviewHandoff = await sourceReviewHandoff(prisma, task, primarySession);
  const activity = { ...main.activity, reviewHandoff: reviewHandoff ? { receiptId: reviewHandoff.receiptId, issueIdentifier: reviewHandoff.issueIdentifier, issueId: reviewHandoff.issueId, publishedAt: reviewHandoff.publishedAt } : null, pendingDelegateResults, projectionRetries, activeDelegateSessionIds: children.filter((_, index) => delegates[index]?.activity.execution.state === "executing").map((child) => child.id) };
  if (activity.state === "idle" && pendingDelegateResults.length) {
    activity.state = "stalled"; activity.cause = "A completed delegate result has not completed delivery to the primary";
    activity.since = pendingDelegateResults[0]!.since; activity.durationMs = pendingDelegateResults[0]!.durationMs;
  } else if (activity.state === "idle" && activity.activeDelegateSessionIds.length) {
    activity.state = "waiting-active-work"; activity.cause = "The primary has no queued work; its delegates have observed active turns";
  }
  // Publication failure is independent of provider liveness. Preserve executing,
  // queued and paused states; expose its bounded recovery separately in all cases.
  const failedNotification = projectionRetries.find((retry) => retry.stage === "notify" && retry.state === "exhausted");
  if (failedNotification && ["idle", "unknown", "stalled"].includes(activity.state)) {
    activity.state = "stalled";
    activity.cause = "Delegate-result notification exhausted its automatic delivery attempts; explicit projection recovery is required";
    activity.since = new Date(failedNotification.failedAt).toISOString();
    activity.durationMs = Math.max(0, now - failedNotification.failedAt);
  }
  // Review is an observed handoff, not an inference from model-reported phase
  // or prose. Preserve all execution, queue, uncertainty and stall evidence.
  if (activity.state === "idle" && reviewHandoff) {
    activity.state = "waiting-owner";
    activity.cause = "A confirmed source-issue Manual Review handoff awaits owner action; no later owner Merge authorization is recorded";
    Object.assign(activity, timing(reviewHandoff.since, now));
  }
  // Explicit progress is reported, not independently observed dependency or
  // owner identity. Never infer either from prose or reuse updatedAt as a phase
  // timestamp: unrelated task updates also change it.
  const reportedDependency = task.recoveryDetail?.trim();
  if (activity.state === "idle" && ["waiting", "blocked"].includes(task.phase) && reportedDependency) {
    activity.state = "waiting-dependency";
    activity.cause = `Task reports a dependency; not independently confirmed: ${reportedDependency}`;
    Object.assign(activity, timing(null, now));
  }
  return { task, session: main.session, history: main.history, questions: main.questions, instructions: main.instructions, delegates, activity };
}
