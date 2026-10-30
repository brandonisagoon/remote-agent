import type { Hono } from "hono";

import type { AppEnv } from "../middleware/context.ts";
import healthRoutes from "./health/index.ts";
import { diagnosticsRoutes } from "./diagnostics/index.ts";
import launchRoutes from "./launches/index.ts";
import sessionEventRoutes from "./session-events/index.ts";
import sessionRoutes from "./sessions/index.ts";
import webhookRoutes from "./webhooks/index.ts";
import { taskRoutes, sessionTaskRoutes } from "./tasks/index.ts";
import { taskSupervisionRoutes } from "./tasks/supervision.ts";
import { taskCompletionRoutes } from "./tasks/completion.ts";
import { legacyEvidenceRoutes } from "./tasks/legacy-evidence.ts";
import { archiveRetentionRoutes } from "./tasks/archive-retention.ts";
import { taskRoutingRoutes } from "./tasks/routing.ts";
import { forwardedLinearRoute } from "./webhooks/post.linear.ts";
import { sourceMessageRoutes } from "./source-messages.ts";

export function mountRoutes(app: Hono<AppEnv>): void {
  app.route("/health", healthRoutes);
  app.route("/api/diagnostics", diagnosticsRoutes);
  app.route("/api/source-messages", sourceMessageRoutes);
  app.route("/webhooks", webhookRoutes);
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", sessionTaskRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/tasks", taskSupervisionRoutes);
  app.route("/api/tasks", taskCompletionRoutes);
  app.route("/api", legacyEvidenceRoutes);
  app.route("/api", archiveRetentionRoutes);
  app.route("/api/routing", taskRoutingRoutes);
  app.route("/api/routing/linear", forwardedLinearRoute);
  app.route("/api/session-events", sessionEventRoutes);
  app.route("/api/launches", launchRoutes);
}
