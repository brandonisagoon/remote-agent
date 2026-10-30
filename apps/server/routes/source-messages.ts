import { apiAuthMiddleware } from "../middleware/api-auth.ts";
import { TASK_READ_DEADLINE_MS, taskRequest } from "../middleware/request-lifetime.ts";
import { RequestLifetimeError } from "../request-lifetime.ts";
import { Hono } from "hono";
import type { AppEnv } from "../middleware/context.ts";
import { ExternalSourceDispositionInput, inspectSourceMessage, ListSourceMessagesInput, listSourceMessages,
  recordExternalSourceDisposition, RetrySourceMessageInput, retrySourceMessage } from "../services/sessions/source-message-recovery.ts";

/** Operator API: protected by the existing network bearer / private local
 * control-socket boundary. External chat references are attestations only. */
export const sourceMessageRoutes = new Hono<AppEnv>();
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

sourceMessageRoutes.get("/", async c => {
  const parsed = ListSourceMessagesInput.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Choose a source state, optional scope and bounded sequence page", details: parsed.error.issues }, 400);
  try { return c.json(await listSourceMessages(c.get("prisma"), c.get("config"), parsed.data)); }
  catch (error) { return c.json({ error: failure(error) }, 409); }
});
sourceMessageRoutes.get("/:sourceId", async c => {
  const sourceId = c.req.param("sourceId");
  if (!await c.get("prisma").runtimeSourceMessage.findUnique({ where: { id: sourceId } })) return c.json({ error: "Source message not found" }, 404);
  try { return c.json(await inspectSourceMessage(c.get("prisma"), c.get("config"), sourceId)); }
  catch (error) { return c.json({ error: failure(error) }, 409); }
});
sourceMessageRoutes.post("/:sourceId/retry", async c => {
  const parsed = RetrySourceMessageInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose the existing ACP owner and provide the inspected revision, reason, authority reference and stable requestKey", details: parsed.error.issues }, 400);
  try {
    const result = await retrySourceMessage({ prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), id: c.req.param("sourceId"), request: parsed.data });
    return c.json(result, result.replayed ? 200 : 202);
  } catch (error) { return c.json({ error: failure(error) }, 409); }
});
// Native report attestations require the owner credential even on session IPC.
sourceMessageRoutes.use("/:sourceId/external-disposition", async (c, next) => {
  const body = await c.req.json().catch(() => null);
  if (body?.queuedReport) return apiAuthMiddleware()(c, next);
  await next();
});
sourceMessageRoutes.post("/:sourceId/external-disposition", async c => {
  const parsed = ExternalSourceDispositionInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide a native chat owner, outcome, evidence, inspected revision, reason and stable requestKey", details: parsed.error.issues }, 400);
  try {
    const record = () => recordExternalSourceDisposition({ prisma: c.get("prisma"), config: c.get("config"), id: c.req.param("sourceId"), request: parsed.data });
    return parsed.data.queuedReport ? await taskRequest(c, TASK_READ_DEADLINE_MS, async () => c.json(await record())) : c.json(await record());
  } catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: failure(error) }, 409); }
});
