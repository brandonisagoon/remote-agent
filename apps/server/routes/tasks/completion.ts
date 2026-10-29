import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { CompletionContractInput, CompletionVerificationInput, inspectTaskCompletion, recordCompletionVerification, setCompletionContract } from "../../services/tasks/completion.ts";

export const taskCompletionRoutes = new Hono<AppEnv>();

// Unlike normal task/session IPC, contract writes always require the owner's
// API credential, including on the otherwise trusted local control socket.
taskCompletionRoutes.use("/:taskId/completion/*", apiAuthMiddleware());
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
