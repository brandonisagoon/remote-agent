import { ensureTaskCleanupTransports, releaseTaskCleanupTransports, returnTaskTransportToWork, inspectCleanupTransport } from "../../services/tasks/cleanup-transport.ts";
import { RequestLifetimeError } from "../../request-lifetime.ts";
import { ADOPTION_DEADLINE_MS, TASK_READ_DEADLINE_MS, taskRequest } from "../../middleware/request-lifetime.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { CompletionContractInput, CompletionVerificationInput, inspectTaskCompletion, recordCompletionVerification, setCompletionContract } from "../../services/tasks/completion.ts";
import { DeliveredRetirementInput, ExternalDeliveryBindingInput } from "../../services/tasks/external-delivery-schema.ts";
import { adoptExternalDeliveries, inspectExternalDeliveries } from "../../services/tasks/external-deliveries.ts";
import { inspectRetirementAuthority, RetirementAuthorityInput, setRetirementAuthority } from "../../services/tasks/retirement-authority.ts";
import { CleanupResumeInput } from "../../services/tasks/cleanup-resume-schema.ts";
import { inspectCleanupResume, resumePreparedCleanup } from "../../services/tasks/cleanup-resume.ts";
import { DoneRetirementInput, adoptDoneRetirement, inspectDoneRetirement } from "../../services/tasks/delivered-retirement.ts";
import { adoptLegacyDelivery, inspectLegacyDelivery } from "../../services/tasks/legacy-delivery.ts";
import { z } from "zod";
import { DeliveredRetirementRevocation, revokeDeliveredRetirement } from "../../services/tasks/delivered-retirement-revocation.ts";

export const taskCompletionRoutes = new Hono<AppEnv>();

// Unlike normal task/session IPC, contract writes always require the owner's
// API credential, including on the otherwise trusted local control socket.
taskCompletionRoutes.use("/:taskId/completion/*", apiAuthMiddleware());
taskCompletionRoutes.delete("/:taskId/completion/delivered-retirement", async c => {
  const parsed = DeliveredRetirementRevocation.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Exact retirement revision and revocation are required" }, 400);
  try { return c.json(await revokeDeliveredRetirement({ prisma: c.get("prisma"), taskId: c.req.param("taskId"), revocation: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.get("/:taskId/completion/delivered-retirement", async c => taskRequest(c, TASK_READ_DEADLINE_MS, async () => {
  try { return c.json(await (c.req.query("mode") === "legacy-delivery" ? inspectLegacyDelivery : inspectDoneRetirement)({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));
taskCompletionRoutes.put("/:taskId/completion/delivered-retirement", async c => taskRequest(c, ADOPTION_DEADLINE_MS, async () => {
  const parsed = z.discriminatedUnion("mode", [DoneRetirementInput, DeliveredRetirementInput]).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Exact delivered-retirement evidence is required", details: parsed.error.issues }, 400);
  try {
    const context = { prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") };
    if (parsed.data.mode === "legacy-delivery") await ensureTaskCleanupTransports({ ...context, runtime: c.get("agentRuntime") });
    return c.json(parsed.data.mode === "existing-preparation" ? await adoptDoneRetirement({ ...context, retirement: parsed.data }) : await adoptLegacyDelivery({ ...context, retirement: parsed.data }));
  }
  catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));
taskCompletionRoutes.get("/:taskId/completion/cleanup-resume", async (c) => {
  try { return c.json(await inspectCleanupResume({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.post("/:taskId/completion/cleanup-resume", async (c) => {
  const parsed = CleanupResumeInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "The existing preparation and exact cleanup-resume binding are required", details: parsed.error.issues }, 400);
  try { return c.json(await resumePreparedCleanup({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), resume: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.get("/:taskId/completion/retirement", async (c) => {
  try { return c.json(await inspectRetirementAuthority({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.put("/:taskId/completion/retirement", async (c) => {
  const parsed = RetirementAuthorityInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Explicit owner retirement authority and exact current bindings are required", details: parsed.error.issues }, 400);
  try { return c.json(await setRetirementAuthority({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), authorization: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.get("/:taskId/completion/external-deliveries", async (c) => taskRequest(c, TASK_READ_DEADLINE_MS, async () => {
  try { return c.json(await inspectExternalDeliveries({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));
taskCompletionRoutes.put("/:taskId/completion/external-deliveries", async (c) => taskRequest(c, ADOPTION_DEADLINE_MS, async () => {
  const parsed = ExternalDeliveryBindingInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Exact external deliveries, accepted evidence and expected revisions are required", details: parsed.error.issues }, 400);
  try {
    await ensureTaskCleanupTransports({ prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), taskId: c.req.param("taskId") });
    return c.json(await adoptExternalDeliveries({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), binding: parsed.data })); }
  catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));
taskCompletionRoutes.get("/:taskId/completion", async (c) => {
  try { return c.json(await inspectTaskCompletion({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.put("/:taskId/completion/contract", async (c) => {
  const parsed = CompletionContractInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Explicit owner completion authority and expected revision are required", details: parsed.error.issues }, 400);
  try { return c.json(await setCompletionContract({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), contract: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
taskCompletionRoutes.post("/:taskId/completion/verification", async (c) => {
  const parsed = CompletionVerificationInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Owner verification evidence and stable requestKey are required", details: parsed.error.issues }, 400);
  try { return c.json(await recordCompletionVerification({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), verification: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

// Reuses owner authentication above; ordinary IPC cannot relocate providers.
taskCompletionRoutes.post("/:taskId/completion/cleanup-transport", async c => taskRequest(c, ADOPTION_DEADLINE_MS, async () => {
  const parsed = z.discriminatedUnion("mode", [z.object({ mode: z.literal("cleanup") }).strict(), z.object({ mode: z.literal("work"), revision: z.number().int().positive() }).strict()]).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Exact cleanup or return-to-work transport selection is required" }, 400);
  try {
    const input = { prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), taskId: c.req.param("taskId") };
    return c.json(parsed.data.mode === "cleanup" ? await releaseTaskCleanupTransports(input) : await returnTaskTransportToWork({ ...input, revision: parsed.data.revision }));
  } catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));

taskCompletionRoutes.get("/:taskId/completion/cleanup-transport", async c => taskRequest(c, TASK_READ_DEADLINE_MS, async () => {
  try { return c.json(await inspectCleanupTransport({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
}));
