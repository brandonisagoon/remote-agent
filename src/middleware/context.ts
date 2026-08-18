import type { MiddlewareHandler } from "hono";

import type { PrismaClient } from "../generated/prisma/client.ts";
import type { ServerConfig } from "../lib/config.ts";
import type { BbClient, CommandClient } from "../types/runtime/index.ts";

export interface AppEnv {
  Variables: {
    config: ServerConfig;
    commandClient: CommandClient;
    bbClient: BbClient;
    prisma: PrismaClient;
  };
}

export interface ContextMiddlewareOptions {
  config: ServerConfig;
  commandClient: CommandClient;
  bbClient: BbClient;
  prisma: PrismaClient;
}

export function contextMiddleware({
  config,
  commandClient,
  bbClient,
  prisma,
}: ContextMiddlewareOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("config", config);
    c.set("commandClient", commandClient);
    c.set("bbClient", bbClient);
    c.set("prisma", prisma);
    await next();
  };
}
