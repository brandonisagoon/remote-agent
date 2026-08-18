import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";

const route = new Hono<AppEnv>();

  // Public, unauthenticated: the deploy script polls this to decide whether a
  // restart succeeded or should be rolled back.
  //
  // It reads a full row on purpose. An earlier version only reported that the
  // process was up, which let a deploy pass its health gate while the service
  // was completely broken: the code expected columns the database did not have,
  // so every webhook failed with "no such column" while /health cheerfully
  // returned 200 and no rollback ever fired.
  //
  // findFirst() selects every scalar column, so schema drift between the
  // deployed client and the database fails here — which is exactly when the
  // deploy should roll back.
route.get("/", async (c) => {
    try {
      await Promise.all([
        c.get("prisma").linearWebhookReceipt.findFirst(),
        c.get("prisma").workerRun.findFirst(),
      ]);
    } catch (error) {
      console.error("Health check failed — database unreadable:", error);
      return c.json(
        {
          status: "unhealthy",
          error: "database unreadable (schema drift or missing migration?)",
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default route;
