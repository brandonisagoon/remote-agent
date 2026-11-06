import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import {
  TOOLING_OPERATION_HEADER, ToolingOperationRefused, admitToolingCallback, afterBoundCallback, beforeBoundCallback, beginSessionToolingOperation,
  StateWriteOutcomeUnknown, isToolingCallbackPath, readOperationStateEvidence, readSessionToolingOperation, registerOperationStateWrite, settleToolingCommand, runAsLegacyContinuation, runWithToolingOperation, toolingOperationDependencies,
  type ToolingOperationDependencies,
} from "../../services/tasks/tooling-operations.ts";
import { ToolingOperationError, ToolingStateFormatError } from "../../services/tasks/tooling-releases.ts";

const failure = (error: unknown) => {
  if (error instanceof StateWriteOutcomeUnknown) return { body: { error: error.message, code: error.code }, status: 503 as const };
  if (error instanceof ToolingOperationRefused) return { body: { error: error.message, code: error.code }, status: error.code === "operation-required" ? 428 as const : error.code === "operation-input" ? 400 as const : 409 as const };
  if (error instanceof ToolingStateFormatError) return { body: { error: error.message, code: error.code }, status: error.code === "invalid-request" ? 400 as const : error.code === "not-found" ? 404 as const : 409 as const };
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

toolingOperationRoutes.get("/:sessionId/tooling-operations/:operationId/state", async c => {
  try { return c.json(await readOperationStateEvidence({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId"), operationId: c.req.param("operationId"),
    header: c.req.header(TOOLING_OPERATION_HEADER) || undefined, query: { family: c.req.query("family"), scopeKey: c.req.query("scopeKey") } })); }
  catch (error) { const { body, status } = failure(error); return c.json(body, status); }
});
toolingOperationRoutes.post("/:sessionId/tooling-operations/:operationId/state-writes", async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "A JSON state write request is required", code: "operation-input" }, 400); }
  try { return c.json(await registerOperationStateWrite({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId"), operationId: c.req.param("operationId"),
    header: c.req.header(TOOLING_OPERATION_HEADER) || undefined, body })); }
  catch (error) { const { body: response, status } = failure(error); return c.json(response, status); }
});

toolingOperationRoutes.post("/:sessionId/tooling-operations/:operationId/settlement", async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "A JSON settlement is required", code: "operation-input" }, 400); }
  try { return c.json(await settleToolingCommand({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId"), operationId: c.req.param("operationId"),
    header: c.req.header(TOOLING_OPERATION_HEADER) || undefined, body })); }
  catch (error) { const { body: response, status } = failure(error); return c.json(response, status); }
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
    if (admission.mode === "legacy-continuation") return runAsLegacyContinuation(admission.reference, admission.code, () => next());
    const prisma = c.get("prisma");
    let state: Awaited<ReturnType<typeof beforeBoundCallback>>;
    // Ownership, admission and producer intent are durable before the
    // handler's first effect; a lost response stays reconcilable.
    try { state = await beforeBoundCallback(prisma, c.get("config"), admission, dependencies); }
    catch (error) { const { body: response, status } = failure(error); return c.json(response, status); }
    try { await runWithToolingOperation(state.binding, () => next(), c.get("config").controlIpcPath); }
    catch (error) { await afterBoundCallback(prisma, admission, state, "exception", dependencies).catch(() => undefined); throw error; }
    // A settlement failure leaves the producer intent unknown (fail closed,
    // reconciled by retrying this operation); it never masks the response.
    await afterBoundCallback(prisma, admission, state, c.res.status, dependencies)
      .catch(error => console.warn(`Tooling operation ${state.binding.operationId} outcome remains unsettled: ${error instanceof Error ? error.message : String(error)}`));
  };
}
