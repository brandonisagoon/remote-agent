import { expect, test } from "bun:test";
import { createControlDiagnostics } from "./control.ts";

function clock() {
  let time = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule(callback: () => void, milliseconds: number) {
      const timer = { at: time + milliseconds, callback };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(milliseconds: number) {
      time += milliseconds;
      for (const timer of [...timers]) if (timer.at <= time) { timers.delete(timer); timer.callback(); }
    },
    pendingTimers: () => timers.size,
  };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const host = () => ({ loadAverage: [1, 2, 3], availableParallelism: 8 });

test("slow store times out independently of a responsive event loop and shares its outstanding probe", async () => {
  const timer = clock();
  let resolveStore!: () => void;
  let calls = 0;
  const probe = new Promise<void>((resolve) => { resolveStore = resolve; });
  const sample = createControlDiagnostics({ ...timer, host, probeStore: () => { calls++; return probe; } });
  const first = sample();
  const second = sample();
  await flush();
  timer.advance(20);
  await flush();
  timer.advance(230);
  const [one, two] = await Promise.all([first, second]);
  expect(one.store).toEqual({ status: "timeout", elapsedMs: 250, budgetMs: 250, sharedProbe: false });
  expect(two.store.sharedProbe).toBe(true);
  expect(one.eventLoop.schedulingDelayMs).toBe(0);
  expect(one.server.deadlineOvershootMs).toBe(0);
  expect(calls).toBe(1);
  // Another request after timeout still does not enqueue another store query.
  const third = sample();
  resolveStore();
  await flush();
  timer.advance(20);
  expect((await third).store.status).toBe("ok");
  expect(calls).toBe(1);
  const recovered = sample();
  await flush();
  timer.advance(20);
  expect((await recovered).store.sharedProbe).toBe(false);
  expect(calls).toBe(2);
  expect(timer.pendingTimers()).toBe(0);
});

test("forced event-loop scheduling delay is distinct from a fast store and reports deadline overshoot", async () => {
  const timer = clock();
  const sample = createControlDiagnostics({ ...timer, host, probeStore: async () => 1 });
  const response = sample();
  await flush();
  // Deterministic delayed timer delivery, without blocking the test process.
  timer.advance(300);
  const result = await response;
  expect(result.store.status).toBe("ok");
  expect(result.store.elapsedMs).toBe(0);
  expect(result.eventLoop.schedulingDelayMs).toBe(280);
  expect(result.server).toEqual({ elapsedMs: 300, deadlineOvershootMs: 50 });
  expect(result.host).toEqual(host());
  expect(timer.pendingTimers()).toBe(0);
});

test("store failures are sanitized and a later sample can recover", async () => {
  const timer = clock();
  let fails = true;
  const sample = createControlDiagnostics({ ...timer, host, probeStore: async () => {
    if (fails) throw new Error("private database path and credentials must not escape");
    return 1;
  } });
  const first = sample();
  await flush(); timer.advance(20);
  const result = await first;
  expect(result.store.status).toBe("error");
  expect(JSON.stringify(result)).not.toContain("private database");
  fails = false;
  const second = sample();
  await flush(); timer.advance(20);
  expect((await second).store.status).toBe("ok");
  expect(timer.pendingTimers()).toBe(0);
});
