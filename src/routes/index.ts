import type { Hono } from "hono";

import type { AppEnv } from "../middleware/context.ts";
import healthRoutes from "./health/index.ts";
import launchRoutes from "./launches/index.ts";
import sessionEventRoutes from "./session-events/index.ts";
import webhookRoutes from "./webhooks/index.ts";

export function mountRoutes(app: Hono<AppEnv>): void {
  app.route("/health", healthRoutes);
  app.route("/webhooks", webhookRoutes);
  app.route("/api/session-events", sessionEventRoutes);
  app.route("/api/launches", launchRoutes);
}
