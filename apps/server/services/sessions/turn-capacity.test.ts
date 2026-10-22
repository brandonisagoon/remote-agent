import { expect, test } from "bun:test";
import { TurnCapacity } from "./turn-capacity.ts";

test("machine slots admit FIFO and release exactly once", async () => {
  const capacity = new TurnCapacity(3);
  const signal = new AbortController().signal;
  const releases = await Promise.all([capacity.acquire(signal), capacity.acquire(signal), capacity.acquire(signal)]);
  let fourthStarted = false;
  const fourth = capacity.acquire(signal).then((release) => { fourthStarted = true; return release; });
  let fifthStarted = false;
  const fifth = capacity.acquire(signal).then((release) => { fifthStarted = true; return release; });
  await Promise.resolve();
  expect(fourthStarted).toBe(false);
  releases[0]!();
  const releaseFourth = await fourth;
  releases[0]!();
  await Promise.resolve();
  expect(fifthStarted).toBe(false);
  releaseFourth();
  (await fifth)();
  releases[1]!(); releases[2]!();
  expect(capacity.full).toBe(false);
});

test("cancelled waiters never consume slots and shutdown rejects queued starts", async () => {
  const capacity = new TurnCapacity(1);
  const first = await capacity.acquire(new AbortController().signal);
  const cancelled = new AbortController();
  const waiting = capacity.acquire(cancelled.signal);
  cancelled.abort();
  await expect(waiting).rejects.toThrow("cancelled");
  const remaining = capacity.acquire(new AbortController().signal);
  first();
  const release = await remaining;
  const stopped = capacity.acquire(new AbortController().signal);
  capacity.stop();
  await expect(stopped).rejects.toThrow("cancelled");
  release();
  await expect(capacity.acquire(new AbortController().signal)).rejects.toThrow("cancelled");
});
