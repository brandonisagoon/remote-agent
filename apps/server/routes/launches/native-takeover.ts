import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { NativeSource, NativeTakeoverInput, inspectNativeTakeover, takeNativeOwnership } from "../../services/launches/native-takeover.ts";

export const nativeTakeoverRoutes = new Hono<AppEnv>();
// Explicit owner bearer is required even on the task-accessible control socket.
nativeTakeoverRoutes.use("*", apiAuthMiddleware());
nativeTakeoverRoutes.get("/", async c => {
  const parsed = NativeSource.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Identify the exact source issue and repository" }, 400);
  try { return c.json(await inspectNativeTakeover({ prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime") }, parsed.data)); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
nativeTakeoverRoutes.post("/", async c => {
  const parsed = NativeTakeoverInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Identify the source, native chat, current revision and stable request key" }, 400);
  try {
    const result = await takeNativeOwnership({ prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime") }, parsed.data);
    return c.json(result, result.state === "pending" ? 202 : 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
