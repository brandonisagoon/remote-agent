import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { inspectDelegates, instructDelegate } from "../../services/launches/delegate-supervision.ts";

const routes = new Hono<AppEnv>();

routes.get("/:sessionId/delegates", async (c) => {
  try {
    return c.json({ delegates: await inspectDelegates(c.get("prisma"), c.get("agentRuntime"), c.req.param("sessionId"), c.req.query("delegateId")) });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 404); }
});

routes.post("/:sessionId/delegates/:delegateId/instructions", async (c) => {
  const parsed = z.object({ requestKey: z.string().min(1).max(200), text: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "A stable requestKey and instruction text are required" }, 400);
  try {
    const instruction = await instructDelegate(c.get("prisma"), c.get("agentRuntime"), { parentSessionId: c.req.param("sessionId"), sessionId: c.req.param("delegateId"), ...parsed.data });
    return c.json({ instruction }, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

export default routes;
