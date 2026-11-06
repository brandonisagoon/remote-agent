import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { verifyBearerToken } from "../../security.ts";
import { ToolingActivationError, activateToolingRelease, getActiveToolingRelease, type ToolingActivationErrorCode } from "../../services/tasks/tooling-releases.ts";
import { inventoryLegacyToolingConsumers } from "../../services/tasks/tooling-operations.ts";

const ActivationBody = z.strictObject({ requestKey: z.string(), revision: z.string(), expectedGeneration: z.number() });
const STATUS: Record<ToolingActivationErrorCode, 400 | 409 | 422> = {
  "invalid-request": 400, "repository-unavailable": 422, "request-conflict": 409, "generation-conflict": 409,
  "restart-required": 409, "preparation-failed": 422, "state-format-incompatible": 409, "legacy-inventory-unavailable": 409,
};

/** Owner release activation. Mounted only on the bearer-authenticated TCP
 * app — never on the trusted control socket or placement forwarding — and
 * never exposed as a session tool. Auth is rechecked here so a mounting
 * mistake cannot make it reachable without the owner token. */
export function toolingReleaseRoutes(options: { enabled: boolean; activate?: typeof activateToolingRelease }) {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (c, next) => {
    if (!verifyBearerToken(c.req.header("authorization") ?? null, c.get("config").apiKey)) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });
  routes.get("/:repositoryId", async (c) => {
    const selection = await getActiveToolingRelease({ prisma: c.get("prisma"), config: c.get("config"), repositoryId: c.req.param("repositoryId") });
    return c.json({ selection, activationEnabled: options.enabled });
  });
  routes.post("/:repositoryId/activations", async (c) => {
    if (!options.enabled) return c.json({ error: "Tooling release activation is unavailable until operation adoption is integrated", code: "activation-unavailable" }, 409);
    const body = ActivationBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Activation requires requestKey, revision and expectedGeneration", code: "invalid-request" }, 400);
    try {
      const selection = await (options.activate ?? activateToolingRelease)({ prisma: c.get("prisma"), config: c.get("config"), repositoryId: c.req.param("repositoryId"), ...body.data },
        { inventoryLegacyConsumers: inventoryLegacyToolingConsumers });
      return c.json({ status: "activated", selection });
    } catch (error) {
      if (!(error instanceof ToolingActivationError)) throw error;
      return c.json({ error: error.message, code: error.code }, STATUS[error.code]);
    }
  });
  return routes;
}
