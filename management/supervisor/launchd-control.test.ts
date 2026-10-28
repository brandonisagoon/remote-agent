import { expect, test } from "bun:test";
import type { RunResult } from "../run.ts";
import { stopLaunchdJob } from "./launchd-control.ts";

const ok: RunResult = { ok: true, exitCode: 0, output: "" };
const absent: RunResult = { ok: false, exitCode: 113, output: 'Could not find service "example" in domain for user gui: 501' };
const denied: RunResult = { ok: false, exitCode: 1, output: "Operation not permitted" };
function fixture(results: RunResult[]) {
  const calls: string[][] = [], waits: number[] = [];
  return { calls, waits, dependencies: {
    run: async (executable: string, args: string[]) => {
      calls.push([executable, ...args]);
      const result = results.shift();
      if (!result) throw new Error("Unexpected extra command");
      return result;
    },
    sleep: async (milliseconds: number) => { waits.push(milliseconds); },
  } };
}

test("bootout waits for the exact old service to disappear before returning", async () => {
  const f = fixture([ok, ok, ok, absent]);
  await stopLaunchdJob("gui/501/example", f.dependencies);
  expect(f.calls).toEqual([
    ["launchctl", "bootout", "gui/501/example"],
    ...Array.from({ length: 3 }, () => ["launchctl", "print", "gui/501/example"]),
  ]);
  expect(f.waits).toEqual([250, 250]);
});

test("an already absent job is an idempotent stop", async () => {
  const f = fixture([absent, absent]);
  await stopLaunchdJob("gui/501/example", f.dependencies);
  expect(f.waits).toEqual([]);
});

test("permission errors are not mistaken for an absent job", async () => {
  await expect(stopLaunchdJob("gui/501/example", fixture([denied, ok]).dependencies)).rejects.toThrow("Operation not permitted");
  await expect(stopLaunchdJob("gui/501/example", fixture([ok, denied]).dependencies)).rejects.toThrow("Operation not permitted");
});

test("removal wait is bounded and never retries the mutation", async () => {
  const f = fixture(Array.from({ length: 41 }, () => ok));
  await expect(stopLaunchdJob("gui/501/example", f.dependencies)).rejects.toThrow("bounded removal wait");
  expect(f.calls.filter((call) => call[1] === "bootout")).toHaveLength(1);
  expect(f.waits).toHaveLength(39);
});
