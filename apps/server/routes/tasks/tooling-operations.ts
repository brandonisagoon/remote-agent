import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import {
  TOOLING_OPERATION_HEADER, ToolingOperationRefused, admitToolingCallback, associateToolingOperation, beginSessionToolingOperation,
  isToolingCallbackPath, readSessionToolingOperation, runAsLegacyContinuation, runWithToolingOperation, toolingOperationDependencies,
  type ToolingOperationDependencies,
} from "../../services/tasks/tooling-operations.ts";
import { ToolingOperationError } from "../../services/tasks/tooling-releases.ts";

const failure = (error: unknown) => {
  if (error instanceof ToolingOperationRefused) return { body: { error: error.message, code: error.code }, status: error.code === "operation-required" ? 428 as const : error.code === "operation-input" ? 400 as const : 409 as const };
  if (error instanceof ToolingOperationError) return { body: { error: error.message, code: error.code }, status: error.code === "invalid-request" ? 400 as const : 409 as const };
  return { body: { error: error instanceof Error ? error.message : String(error) }, status: 409 as const };
};

/** Operation identity endpoints. Neither grants compute, cleanup or delivery
 * authority, and neither accepts an executable path or release ID. */
export const toolingOperationRoutes = new Hono<AppEnv>();
toolingOperationRoutes.post("/:sessionId/tooling-operations", async c => {
  let request: unknown;
  try { request = await c.req.json(); } catch { return c.json({ error: "A JSON tooling operation request is required", code: "operation-input" }, 400); }
  try { return c.json(await beginSessionToolingOperation({ prisma: c.get("prisma"), config: c.get("config"), runtime: c.get("agentRuntime"), sessionId: c.req.param("sessionId"), request })); }
  catch (error) { const { body, status } = failure(error); return c.json(body, status); }
});
toolingOperationRoutes.get("/:sessionId/tooling-operations/:operationId", async c => {
  const owned = await readSessionToolingOperation({ prisma: c.get("prisma"), sessionId: c.req.param("sessionId"), operationId: c.req.param("operationId") });
  return owned ? c.json(owned) : c.json({ error: "No such tooling operation for this session" }, 404);
});

/** Single inventory point for adapter effect callbacks. Runs before every
 * matching route handler; the handler's own authority checks still run. */
export function toolingOperationGuard(dependencies: ToolingOperationDependencies = toolingOperationDependencies): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isToolingCallbackPath(c.req.method, c.req.path)) return next();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await c.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* The handler reports its own malformed-body error. */ }
    let admission: Awaited<ReturnType<typeof admitToolingCallback>>;
    try {
      admission = await admitToolingCallback({ prisma: c.get("prisma"), config: c.get("config"), method: c.req.method, pathname: c.req.path,
        header: c.req.header(TOOLING_OPERATION_HEADER) || undefined, body }, dependencies);
    } catch (error) { const { body: response, status } = failure(error); return c.json(response, status); }
    if (!admission || admission.mode === "pre-protocol") return next();
    if (admission.mode === "legacy-continuation") return runAsLegacyContinuation(admission.reference, () => next());
    const { binding, callback } = admission;
    await runWithToolingOperation(binding, () => next());
    // Record which durable operations this binding produced only after the
    // handler succeeded; a failed or unknown effect keeps no association.
    // The continued existing receipt becomes this operation's, closing its
    // legacy path and pointing observers at this binding.
    if (c.res.status >= 200 && c.res.status < 300) {
      const response: unknown = callback.associate ? await c.res.clone().json().catch(() => ({})) : {};
      const references = [...(admission.reference ? [admission.reference] : []),
        ...(callback.associate?.(body, response && typeof response === "object" ? response as Record<string, unknown> : {}) ?? [])];
      if (references.length) await associateToolingOperation(c.get("prisma"), binding, references);
    }
  };
}
