import type { MiddlewareHandler } from "hono";

import type { PrismaClient } from "../generated/prisma/client.ts";
import type { ServerConfig } from "../lib/config.ts";
import type { AgentSessionRuntime, CommandClient } from "../types/runtime/index.ts";

export interface AppEnv {
  Variables: {
    config: ServerConfig;
    commandClient: CommandClient;
    agentRuntime: AgentSessionRuntime;
    prisma: PrismaClient;
  };
}

export interface ContextMiddlewareOptions {
  config: ServerConfig;
  commandClient: CommandClient;
  agentRuntime: AgentSessionRuntime;
  prisma: PrismaClient;
}

export function contextMiddleware({
  config,
  commandClient,
  agentRuntime,
  prisma,
}: ContextMiddlewareOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("config", config);
    c.set("commandClient", commandClient);
    c.set("agentRuntime", agentRuntime);
    c.set("prisma", prisma);
    await next();
  };
}
