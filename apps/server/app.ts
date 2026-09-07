import { Hono } from "hono";

import type { ServerConfig } from "../../lib/config.ts";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { bunCommandClient } from "./transports/command/index.ts";
import { apiAuthMiddleware } from "./middleware/api-auth.ts";
import { cacheControlMiddleware } from "./middleware/cache-control.ts";
import {
  contextMiddleware,
  type AppEnv,
} from "./middleware/context.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { mountRoutes } from "./routes/index.ts";
import type { AgentSessionRuntime, CommandClient } from "../../types/runtime/index.ts";

export interface CreateAppOptions {
  config: ServerConfig;
  commandClient?: CommandClient;
  agentRuntime: AgentSessionRuntime;
  prisma: PrismaClient;
  /** For the control socket: callers are gated by filesystem permissions,
      so the API bearer check is skipped. Never set for the network port. */
  trustLocal?: boolean;
}

export function createApp({
  config,
  commandClient = bunCommandClient,
  agentRuntime,
  prisma,
  trustLocal = false,
}: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", contextMiddleware({
    config,
    commandClient,
    agentRuntime,
    prisma,
  }));
  app.use("*", cacheControlMiddleware());
  if (!trustLocal) app.use("/api/*", apiAuthMiddleware());
  app.onError(errorHandler);

  mountRoutes(app);

  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  return app;
}
