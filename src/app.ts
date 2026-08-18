import { Hono } from "hono";

import type { ServerConfig } from "./lib/config.ts";
import type { PrismaClient } from "./generated/prisma/client.ts";
import { bunCommandClient } from "./lib/transports/command/index.ts";
import { createBbClient } from "./lib/transports/bb/index.ts";
import { apiAuthMiddleware } from "./middleware/api-auth.ts";
import { cacheControlMiddleware } from "./middleware/cache-control.ts";
import {
  contextMiddleware,
  type AppEnv,
} from "./middleware/context.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { mountRoutes } from "./routes/index.ts";
import type { BbClient, CommandClient } from "./types/runtime/index.ts";

export interface CreateAppOptions {
  config: ServerConfig;
  commandClient?: CommandClient;
  bbClient?: BbClient;
  prisma: PrismaClient;
}

export function createApp({
  config,
  commandClient = bunCommandClient,
  bbClient = createBbClient(config.bbBaseUrl),
  prisma,
}: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", contextMiddleware({ config, commandClient, bbClient, prisma }));
  app.use("*", cacheControlMiddleware());
  app.use("/api/*", apiAuthMiddleware());
  app.onError(errorHandler);

  mountRoutes(app);

  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  return app;
}
