import type { ErrorHandler } from "hono";

import type { AppEnv } from "./context.ts";

export const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
  console.error("Unhandled error:", error);
  return c.json({ error: "Internal Server Error" }, 500);
};
