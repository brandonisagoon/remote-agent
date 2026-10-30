import type { Context } from "hono";
import type { AppEnv } from "./context.ts";
import { RequestLifetimeError, withRequestLifetime } from "../request-lifetime.ts";

export const TASK_READ_DEADLINE_MS = 60_000;
export const ADOPTION_DEADLINE_MS = 240_000;

/** Called inside authenticated handlers (or the owner-only control socket).
 * Bun passes its Server as Hono's env. Per-request 0 is documented and avoids
 * the network idle timer cutting off a valid bounded observation. Unix listeners
 * ignore this API; control-socket.ts supplies their bounded 255s transport. */
export async function taskRequest(c: Context<AppEnv>, timeoutMs: number, work: () => Promise<Response>): Promise<Response> {
  const server = c.env as { timeout?: (request: Request, seconds: number) => void } | undefined;
  server?.timeout?.(c.req.raw, 0);
  let timings = new Map<string, number>();
  try {
    let response: Response;
    try { response = await withRequestLifetime({ timeoutMs, signal: c.req.raw.signal, onTimings: value => { timings = value; } }, work); }
    catch (error) {
      if (!(error instanceof RequestLifetimeError)) throw error;
      response = c.json({ error: error.message, code: error.code, stages: error.stages, deadlineMs: timeoutMs,
        retry: "Repeat inspection. For adoption, replay the same requestKey and exact request body to recover an already accepted result." }, 504);
    }
    const safe = [...timings].filter(([name]) => /^[a-z-]+$/.test(name));
    if (safe.length) response.headers.set("Server-Timing", safe.map(([name, duration]) => `${name};dur=${Math.round(duration)}`).join(", "));
    return response;
  } finally {
    // Leave a bounded response-write window, including after an application
    // timeout. Do not restore the idle timer while observations are still valid.
    try { server?.timeout?.(c.req.raw, 15); } catch { /* client already disconnected */ }
  }
}
