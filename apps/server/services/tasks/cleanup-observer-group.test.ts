import { expect, test } from "bun:test";
import { waitForOwnedGroupExit } from "./cleanup-resource-observer.ts";

type Dependencies = NonNullable<Parameters<typeof waitForOwnedGroupExit>[1]>;
type Scan = Awaited<ReturnType<Dependencies["scan"]>>;
const absent: Scan = { error: null, stdout: "  12\n 34\n", stderr: "" };
const timeout: Scan = { error: { killed: true, signal: "SIGTERM", code: null }, stdout: "", stderr: "" };
function clock(scan: (index: number, budget: number) => { duration: number; result: Scan }) {
  let now = 0;
  const budgets: number[] = [];
  const dependencies: Dependencies = {
    now: () => now,
    sleep: async ms => { now += ms; },
    scan: async budget => {
      budgets.push(budget);
      const next = scan(budgets.length - 1, budget);
      now += next.duration;
      return next.result;
    },
  };
  return { dependencies, budgets, elapsed: () => now };
}

test("a managed scan timeout requires a new complete absence proof", async () => {
  const f = clock(index => index === 0
    ? { duration: 260, result: { ...timeout, stdout: absent.stdout } }
    : { duration: 2, result: absent });
  await waitForOwnedGroupExit(77, f.dependencies);
  expect(f.budgets).toEqual([250, 250]);
  expect(f.elapsed()).toBe(272);
});

test("persistent unknown scans exhaust the original budget with a shortened last scan", async () => {
  const f = clock((_index, budget) => ({ duration: budget, result: timeout }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.budgets).toEqual([250, 250, 250, 220]);
  expect(f.elapsed()).toBe(1000);
});

test("a valid absent scan arriving at the deadline is still refused", async () => {
  const f = clock(index => ({ duration: index === 0 ? 740 : 250, result: index === 0 ? timeout : absent }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.budgets).toEqual([250, 250]);
  expect(f.elapsed()).toBe(1000);
});

test("a present group cannot be accepted even after a scan timeout", async () => {
  const f = clock((index, budget) => ({ duration: budget, result: index === 0 ? timeout : { ...absent, stdout: "12\n77\n" } }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.elapsed()).toBe(1000);
});

test.each([
  { ...timeout, error: { ...timeout.error, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } },
  { ...timeout, error: { code: "EPERM" } },
  { ...timeout, error: { killed: false, signal: "SIGTERM" } },
  { ...timeout, error: { killed: true, signal: "SIGKILL" } },
  { ...timeout, stderr: "warning" },
  { ...absent, stderr: "warning" },
  { ...absent, stdout: "" },
  { ...absent, stdout: "12\nnot-a-group\n" },
  { ...absent, stdout: "12\n9007199254740992\n" },
] satisfies Scan[])("an invalid or non-timeout scan refuses immediately: %j", async result => {
  const f = clock(() => ({ duration: 1, result }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.budgets).toEqual([250]);
});

test("valid process-group zero rows do not invalidate an otherwise complete scan", async () => {
  const f = clock(() => ({ duration: 1, result: { ...absent, stdout: " 0\n12\n" } }));
  await waitForOwnedGroupExit(77, f.dependencies);
  expect(f.budgets).toEqual([250]);
});
