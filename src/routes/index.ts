import type { Hono } from "hono";

import type { AppEnv } from "../middleware/context.ts";
import healthRoutes from "./health/index.ts";
import launchRoutes from "./launches/index.ts";
import sessionRoutes from "./sessions/index.ts";
import webhookRoutes from "./webhooks/index.ts";

export function mountRoutes(app: Hono<AppEnv>): void {
  app.route("/health", healthRoutes);
  app.route("/webhooks", webhookRoutes);
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/launches", launchRoutes);
}
