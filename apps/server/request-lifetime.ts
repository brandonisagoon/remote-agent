import { AsyncLocalStorage } from "node:async_hooks";

type Lifetime = { deadline: number; timeoutMs: number; signal?: AbortSignal; closed: boolean; stages: Map<string, number>; timings: Map<string, number> };
const lifetime = new AsyncLocalStorage<Lifetime>();
export class RequestLifetimeError extends Error {
  readonly code: "REQUEST_DEADLINE" | "REQUEST_CANCELLED";
  readonly stages: string[];
  constructor(current: Lifetime, cancelled = false) {
    super(cancelled ? "Request was disconnected" : "Request deadline exceeded");
    this.code = cancelled ? "REQUEST_CANCELLED" : "REQUEST_DEADLINE";
    this.stages = [...current.stages.keys()];
  }
}

/** No ambient request means an existing internal caller, not a new authority. */
export function assertRequestActive(): void {
  const current = lifetime.getStore();
  if (current && (current.closed || current.signal?.aborted || performance.now() >= current.deadline)) throw new RequestLifetimeError(current, current.signal?.aborted);
}

export function enterRequestStage(stage: string): () => void {
  assertRequestActive();
  const current = lifetime.getStore(), started = performance.now();
  if (!current) return () => undefined;
  current.stages.set(stage, (current.stages.get(stage) ?? 0) + 1);
  return () => {
    const remaining = current.stages.get(stage)! - 1;
    if (remaining) current.stages.set(stage, remaining); else current.stages.delete(stage);
    current.timings.set(stage, (current.timings.get(stage) ?? 0) + performance.now() - started);
  };
}

/** A deadline stops progression, including a late observation returning after
 * the HTTP response. Adoption also checks this inside its existing transaction
 * immediately before writes and before returning, so that such work rolls back. */
export async function withRequestLifetime<T>(input: { timeoutMs: number; signal?: AbortSignal; onTimings?: (timings: Map<string, number>) => void }, work: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("Request deadline must be a positive integer");
  const current: Lifetime = { ...input, deadline: performance.now() + input.timeoutMs, closed: false, stages: new Map(), timings: new Map() };
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    const fail = (cancelled: boolean) => { current.closed = true; reject(new RequestLifetimeError(current, cancelled)); };
    timer = setTimeout(() => fail(false), input.timeoutMs);
    abort = () => fail(true);
    input.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await lifetime.run(current, async () => {
      assertRequestActive();
      return Promise.race([expired, (async () => { const result = await work(); assertRequestActive(); return result; })()]);
    });
  } finally {
    current.closed = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    input.onTimings?.(current.timings);
  }
}
