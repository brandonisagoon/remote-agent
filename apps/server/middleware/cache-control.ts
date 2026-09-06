import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "./context.ts";

/**
 * Responses are per-request state about live agent sessions; nothing here is
 * ever safe to cache.
 */
export function cacheControlMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
}
