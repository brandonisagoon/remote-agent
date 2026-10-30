import { PreparationAttempt, requestFinalizationPreparation, requestFinalizationConfirmation, assertNoPendingPreparation } from "../../services/tasks/finalization-preparation.ts";
import { CleanupEnqueueInput, enqueueTaskCleanup } from "../../services/tasks/cleanup-inbox.ts";
import { deliverInstructions } from "../../services/sessions/inbox.ts";
import { archiveRetentionProjection, assertArchiveResourceUpdate } from "../../services/tasks/archive-retention.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { taskForSession } from "../../services/tasks/store.ts";
import { scopeConfig } from "../../../../lib/config.ts";
import { getSourceIssueForPlanCapture, updateSourceIssue } from "../../integrations/linear/session-store/source-issue/index.ts";
import { splicePlanSection } from "../../services/sessions/plan-capture.ts";
import { launchTask } from "../../services/tasks/launch.ts";
import { isSafeBranchName } from "../../workers/product/workflow/branch.ts";
import { askSessionQuestion, linkedSourceIssue, NoLinkedSourceIssueError } from "../../services/sessions/questions.ts";
import { IssueUpdateInput, publishSessionIssueUpdate } from "../../services/sessions/issue-updates.ts";
import { downloadSourceAttachment } from "../../services/sessions/source-attachments.ts";
import { ChildIssueUpdateInput, publishChildIssueUpdate, readSessionWorkGraph } from "../../services/sessions/child-issues.ts";
import { ToolingCapabilityInput, resolveSessionToolingCapability } from "../../services/tasks/tooling-capabilities.ts";
import { BrowserStopInput, resolveBrowserStopAuthority } from "../../services/tasks/browser-stop-authority.ts";
import { LocalServiceStopInput, resolveLocalServiceStopAuthority } from "../../services/tasks/local-service-stop-authority.ts";
import { FinalizationInput, prepareTaskFinalization, confirmTaskFinalization } from "../../services/tasks/finalization.ts";
import { renewCleanupAuthority } from "../../services/tasks/cleanup-authority.ts";
import { CleanupResourceKeys } from "../../services/tasks/cleanup-resource-scope.ts";
import { externalFinalizationProjection } from "../../services/tasks/external-finalization.ts";
import { assertLegacyEvidenceResourceUpdate, legacyEvidenceProjection } from "../../services/tasks/legacy-evidence.ts";
import { assertCleanupResourceUpdate } from "../../services/tasks/cleanup-lifecycle.ts";
import { cleanupCandidates } from "../../services/tasks/cleanup-candidates.ts";
import { CleanupProgressInput, recordCleanupProgress } from "../../services/tasks/cleanup-progress.ts";
import { CleanupReportRequest, publishCleanupReport, cleanupProjection } from "../../services/tasks/cleanup-report.ts";

import { SourceReplyInput, replyToSource, readReplyContext } from "../../services/sessions/source-messages.ts";

import { taskResponse } from "./response.ts";

export const taskRoutes = new Hono<AppEnv>();
export const sessionTaskRoutes = new Hono<AppEnv>();

taskRoutes.post("/:taskId/cleanup-request", async (c) => {
  const request = CleanupEnqueueInput.safeParse(await c.req.json());
  if (!request.success) return c.json({ error: "A stable cleanup scheduling requestKey is required" }, 400);
  try {
    const result = await enqueueTaskCleanup({ ...request.data, runtime: c.get("agentRuntime"), prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") });
    void deliverInstructions(c.get("prisma"), c.get("agentRuntime"), c.get("config")).catch(() => undefined);
    return c.json(result, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutes.post("/:taskId/cleanup-progress", async (c) => {
  const parsed = CleanupProgressInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the bound cleanup operation and bounded resource diagnostics" }, 400);
  try { return c.json(await recordCleanupProgress({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), progress: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutes.post("/:taskId/cleanup-report", async (c) => {
  const request = CleanupReportRequest.safeParse(await c.req.json());
  if (!request.success) return c.json({ error: "Use the existing finalization requestKey; cleanup report content is server-owned" }, 400);
  try { return c.json(await publishCleanupReport({ ...request.data, prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/source-reply", async (c) => {
  const parsed = SourceReplyInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A stable requestKey and reply body are required" }, 400);
  try { return c.json(await replyToSource({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/reply-context", async (c) => {
  const parsed = z.object({ sourceMessageId: z.string().min(1) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid reply context" }, 400);
  try { return c.json(await readReplyContext({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutes.post("/:taskId/cleanup-authority", async (c) => {
  const parsed = FinalizationInput.pick({ requestKey: true, finalizationVersion: true }).extend({ resourceKeys: CleanupResourceKeys.optional() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A stable cleanup requestKey is required" }, 400);
  const task = await c.get("prisma").remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
  if (!task?.primarySessionId) return c.json({ error: "Task has no original primary" }, 409);
  try {
    return c.json(await renewCleanupAuthority({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: task.primarySessionId }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

for (const [action, finalize] of [["prepare-finalization", prepareTaskFinalization], ["confirm-finalization", confirmTaskFinalization]] as const) {
  // Task-bound cleanup renewals resolve the original primary locally. They do
  // not fetch the full task/retention projection before every native batch.
  taskRoutes.post(`/:taskId/${action}`, async (c) => {
    const parsed = FinalizationInput.extend({ preparation: PreparationAttempt.optional(), confirmation: PreparationAttempt.optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "A stable finalization requestKey is required" }, 400);
    const task = await c.get("prisma").remoteTask.findUnique({ where: { id: c.req.param("taskId") } });
    if (!task?.primarySessionId) return c.json({ error: "Task has no original primary" }, 409);
    try {
      const input = { ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: task.primarySessionId };
      if (parsed.data.confirmation) {
        if (action !== "confirm-finalization" || parsed.data.preparation || !input.cleanup || input.authorityOnly) throw new Error("Asynchronous confirmation requires the existing full cleanup operation");
        const value = await requestFinalizationConfirmation({ ...input, cleanup: true }, parsed.data.confirmation);
        return c.json(value, value.confirmation.state === "pending" || value.confirmation.state === "running" ? 202 : 200);
      }
      if (parsed.data.preparation) {
        if (action !== "prepare-finalization" || !input.cleanup || input.authorityOnly) throw new Error("Asynchronous preparation requires a full cleanup check");
        const value = await requestFinalizationPreparation({ ...input, cleanup: true }, parsed.data.preparation);
        return c.json(value, value.preparation.state === "pending" || value.preparation.state === "running" ? 202 : 200);
      }
      if (action === "prepare-finalization" && !input.authorityOnly) await assertNoPendingPreparation(input);
      return c.json(await finalize(input));
    }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  sessionTaskRoutes.post(`/:sessionId/${action}`, async (c) => {
    const parsed = FinalizationInput.extend({ preparation: PreparationAttempt.optional(), confirmation: PreparationAttempt.optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "A stable finalization requestKey is required" }, 400);
    try {
      const input = { ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId") };
      if (parsed.data.confirmation) {
        if (action !== "confirm-finalization" || parsed.data.preparation || !input.cleanup || input.authorityOnly) throw new Error("Asynchronous confirmation requires the existing full cleanup operation");
        const value = await requestFinalizationConfirmation({ ...input, cleanup: true }, parsed.data.confirmation);
        return c.json(value, value.confirmation.state === "pending" || value.confirmation.state === "running" ? 202 : 200);
      }
      if (parsed.data.preparation) {
        if (action !== "prepare-finalization" || !input.cleanup || input.authorityOnly) throw new Error("Asynchronous preparation requires a full cleanup check");
        const value = await requestFinalizationPreparation({ ...input, cleanup: true }, parsed.data.preparation);
        return c.json(value, value.preparation.state === "pending" || value.preparation.state === "running" ? 202 : 200);
      }
      if (action === "prepare-finalization" && !input.authorityOnly) await assertNoPendingPreparation(input);
      return c.json(await finalize(input));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
}

sessionTaskRoutes.post("/:sessionId/tooling-capability", async (c) => {
  const parsed = ToolingCapabilityInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "An allowlisted tooling capability name is required" }, 400);
  try {
    return c.json(await resolveSessionToolingCapability({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/browser-stop-authority", async (c) => {
  const parsed = BrowserStopInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "An exact browser resource key is required" }, 400);
  try {
    return c.json(await resolveBrowserStopAuthority({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/local-service-stop-authority", async (c) => {
  const parsed = LocalServiceStopInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "An exact local service resource key is required" }, 400);
  try {
    return c.json(await resolveLocalServiceStopAuthority({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.get("/:sessionId/source-issue", async (c) => {
  try {
    const { issue } = await linkedSourceIssue({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") });
    return c.json({ issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description, state: issue.state, labels: issue.labels, availableStates: issue.team.states.nodes } });
  } catch (error) {
    if (error instanceof NoLinkedSourceIssueError) return c.json({ code: error.code, error: error.message }, 404);
    throw error;
  }
});

sessionTaskRoutes.get("/:sessionId/work-graph", async (c) => {
  try {
    return c.json(await readSessionWorkGraph({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/child-issue-update", async (c) => {
  const parsed = ChildIssueUpdateInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid child update", details: parsed.error.issues }, 400);
  try {
    return c.json(await publishChildIssueUpdate({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/source-attachment", async (c) => {
  const parsed = z.object({ url: z.url().max(4096) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A Linear attachment URL from the source issue is required" }, 400);
  try {
    return c.json(await downloadSourceAttachment({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/issue-update", async (c) => {
  const parsed = IssueUpdateInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid issue update", details: parsed.error.issues }, 400);
  try {
    return c.json(await publishSessionIssueUpdate({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

sessionTaskRoutes.post("/:sessionId/question", async (c) => {
  const parsed = z.object({ requestKey: z.string().min(1).max(200), body: z.string().min(1).max(30_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A question and stable requestKey are required" }, 400);
  return c.json(await askSessionQuestion({ ...parsed.data, prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId") }));
});

taskRoutes.post("/", async (c) => {
  const parsed = z.object({ requestKey: z.string().min(1).max(200), repositoryId: z.string().min(1), branchName: z.string().refine(isSafeBranchName, "Invalid branch name"), prompt: z.string().min(1).max(100_000), provider: z.enum(["codex", "claude"]).default("codex") }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid task launch", details: parsed.error.issues }, 400);
  const task = await launchTask({ ...parsed.data, config: c.get("config"), prisma: c.get("prisma"), runtime: c.get("agentRuntime") });
  return c.json({ task: taskResponse(task) }, 201);
});

taskRoutes.get("/", async (c) => {
  const prisma = c.get("prisma");
  // Preserve the desktop's recent-task view. Maintenance explicitly requests
  // a stable ID order so activity cannot move tasks between cursor pages.
  if (c.req.query("pagination") !== "id") {
    const tasks = await prisma.remoteTask.findMany({ include: { resources: true }, orderBy: { updatedAt: "desc" }, take: 100 });
    return c.json({ tasks: await Promise.all(tasks.map(async (task) => ({ ...taskResponse(task), ...await externalFinalizationProjection(prisma, task), ...await legacyEvidenceProjection(prisma, c.get("config"), task), ...await archiveRetentionProjection(prisma, c.get("config"), task), ...await cleanupProjection(prisma, c.get("config"), task) }))) });
  }
  const cursor = c.req.query("cursor");
  const rows = await prisma.remoteTask.findMany({ include: { resources: true }, orderBy: { id: "asc" }, take: 101, ...(cursor ? { where: { id: { gt: cursor } } } : {}) });
  const tasks = rows.slice(0, 100);
  const eligible = await cleanupCandidates(prisma, c.get("config"), tasks);
  return c.json({ tasks: await Promise.all(tasks.map(async (task) => {
    const cleanup = await cleanupProjection(prisma, c.get("config"), task);
    return { ...taskResponse(task), ...await externalFinalizationProjection(prisma, task), ...await legacyEvidenceProjection(prisma, c.get("config"), task), ...await archiveRetentionProjection(prisma, c.get("config"), task), ...cleanup,
      finalizationPending: task.phase === "closed" ? Boolean("cleanupOperation" in cleanup && cleanup.cleanupOperation?.reportingPending) : eligible.has(task.id) };
  })), nextCursor: rows.length > 100 ? tasks.at(-1)!.id : null });
});
taskRoutes.get("/:taskId", async (c) => {
  const task = await c.get("prisma").remoteTask.findUnique({ where: { id: c.req.param("taskId") }, include: { resources: true } });
  return task ? c.json({ task: { ...taskResponse(task), ...await externalFinalizationProjection(c.get("prisma"), task), ...await legacyEvidenceProjection(c.get("prisma"), c.get("config"), task), ...await archiveRetentionProjection(c.get("prisma"), c.get("config"), task), ...await cleanupProjection(c.get("prisma"), c.get("config"), task) } }) : c.json({ error: "Task not found" }, 404);
});

sessionTaskRoutes.get("/:sessionId/task", async (c) => {
  const task = await taskForSession(c.get("prisma"), c.req.param("sessionId"));
  return task ? c.json({ task: { ...taskResponse(task), ...await externalFinalizationProjection(c.get("prisma"), task), ...await legacyEvidenceProjection(c.get("prisma"), c.get("config"), task), ...await archiveRetentionProjection(c.get("prisma"), c.get("config"), task), ...await cleanupProjection(c.get("prisma"), c.get("config"), task) } }) : c.json({ error: "Session has no managed task" }, 404);
});

const Progress = z.object({
  phase: z.enum(["preparing", "working", "waiting", "blocked", "review", "complete"]).optional(),
  environmentStatus: z.enum(["pending", "preparing", "ready", "degraded", "stopped"]).optional(),
  recoveryDetail: z.string().max(8000).nullable().optional(),
}).strict();

sessionTaskRoutes.patch("/:sessionId/task", async (c) => {
  const parsed = Progress.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid task progress", details: parsed.error.issues }, 400);
  const prisma = c.get("prisma");
  const task = await taskForSession(prisma, c.req.param("sessionId"));
  if (!task) return c.json({ error: "Session has no managed task" }, 404);
  return c.json({ task: taskResponse(await prisma.remoteTask.update({ where: { id: task.id }, data: parsed.data })) });
});

const Resource = z.object({
  key: z.string().min(1).max(100), kind: z.string().min(1).max(100),
  purpose: z.enum(["development", "review", "browser", "tooling"]),
  externalId: z.string().min(1).max(4096),
  state: z.enum(["allocated", "ready", "failed", "unknown", "released"]).default("allocated"),
  metadata: z.record(z.string(), z.json()).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();

sessionTaskRoutes.put("/:sessionId/task/resources", async (c) => {
  const parsed = Resource.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid resource receipt", details: parsed.error.issues }, 400);
  const prisma = c.get("prisma");
  const task = await taskForSession(prisma, c.req.param("sessionId"));
  if (!task) return c.json({ error: "Session has no managed task" }, 404);
  const { key, expiresAt, ...data } = parsed.data;
  const values = { ...data, expiresAt: expiresAt ? new Date(expiresAt) : null };
  try {
    const resource = await prisma.$transaction(async (tx) => {
      const existing = await tx.remoteTaskResource.upsert({
        where: { taskId_key: { taskId: task.id, key } }, create: { taskId: task.id, key, ...values }, update: {},
      });
      if (existing.externalId !== data.externalId || existing.kind !== data.kind || existing.purpose !== data.purpose) throw new Error("Resource key already belongs to another resource; record a new key");
      await assertLegacyEvidenceResourceUpdate(tx, existing, values);
      await assertArchiveResourceUpdate(tx, existing, values);
      await assertCleanupResourceUpdate({ prisma: tx, config: c.get("config"), sessionId: c.req.param("sessionId"), taskId: task.id }, existing, values);
      return tx.remoteTaskResource.update({ where: { id: existing.id }, data: { state: values.state, metadata: values.metadata, expiresAt: values.expiresAt } });
    });
    return c.json({ resource });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

// Explicit tool path works for both providers, including Codex (which does
// not emit Claude's ExitPlanMode permission request).
sessionTaskRoutes.put("/:sessionId/plan", async (c) => {
  const parsed = z.object({ plan: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A nonempty plan is required" }, 400);
  const prisma = c.get("prisma");
  const session = await prisma.runtimeSession.findUnique({ where: { id: c.req.param("sessionId") } });
  if (!session) return c.json({ error: "Session not found" }, 404);
  const link = await prisma.runtimeSessionResourceLink.findFirst({ where: {
    runtimeSessionId: session.id, provider: "linear", resourceType: "issue-identifier", relationship: "handles", endedAt: null,
  } });
  if (!link) return c.json({ error: "Session has no linked Linear issue" }, 409);
  const config = scopeConfig(c.get("config"), { repositoryId: session.repositoryId, connectionId: link.connectionId });
  const issue = await getSourceIssueForPlanCapture(config, { id: link.externalId });
  if (!issue) return c.json({ error: "Linked issue not found" }, 404);
  await updateSourceIssue(config, { id: issue.id }, { description: splicePlanSection(issue.description, parsed.data.plan) });
  return c.json({ persisted: true, issueIdentifier: link.externalId });
});
