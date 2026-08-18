import type { MiddlewareHandler } from "hono";

import { verifyBearerToken } from "../lib/security.ts";
import type { AppEnv } from "./context.ts";

/**
 * Guard the whole state API in one place rather than per route, so a new
 * /api route cannot be added without authentication by omission.
 */
export function apiAuthMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");
    if (
      !verifyBearerToken(
        c.req.header("authorization") ?? null,
        config.apiKey,
      )
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
