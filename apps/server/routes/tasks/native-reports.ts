import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { taskRequest, TASK_READ_DEADLINE_MS } from "../../middleware/request-lifetime.ts";
import { RequestLifetimeError } from "../../request-lifetime.ts";
import { NativeReportInput } from "../../services/sessions/native-report-origin.ts";
import { inspectNativeReportPublisher, publishNativeReport } from "../../services/sessions/native-report-publisher.ts";

export const nativeReportRoutes = new Hono<AppEnv>();
nativeReportRoutes.use("/:taskId/native-reports", apiAuthMiddleware());
nativeReportRoutes.get("/:taskId/native-reports", async c => {
  try { return c.json(await inspectNativeReportPublisher({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
nativeReportRoutes.post("/:taskId/native-reports", async c => {
  const request = NativeReportInput.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: "Provide the inspected owner digest, native turn origin, report body and stable requestKey", details: request.error.issues }, 400);
  return taskRequest(c, TASK_READ_DEADLINE_MS, async () => {
    try { return c.json(await publishNativeReport({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), request: request.data })); }
    catch (error) { if (error instanceof RequestLifetimeError) throw error; return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
});
