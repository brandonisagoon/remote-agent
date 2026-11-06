import { expect, test } from "bun:test";
import { waitForOwnedGroupExit } from "./cleanup-resource-observer.ts";

type Dependencies = NonNullable<Parameters<typeof waitForOwnedGroupExit>[1]>;
const absent = { code: "ESRCH" };
function clock(query: (index: number) => { duration: number; error?: unknown }) {
  let now = 0;
  const queries: Array<[number, number]> = [];
  const dependencies: Dependencies = {
    now: () => now,
    sleep: async ms => { now += ms; },
    query: (pid, signal) => {
      queries.push([pid, signal]);
      const next = query(queries.length - 1);
      now += next.duration;
      if ("error" in next) throw next.error;
    },
  };
  return { dependencies, queries, elapsed: () => now };
}

test("only ESRCH proves group absence; every kernel query uses signal zero", async () => {
  const f = clock(() => ({ duration: 1, error: absent }));
  await waitForOwnedGroupExit(77, f.dependencies);
  expect(f.queries).toEqual([[-77, 0]]);
});

test("a group still containing descendants waits until the whole group is absent", async () => {
  const f = clock(index => index < 2 ? { duration: 1 } : { duration: 1, error: absent });
  await waitForOwnedGroupExit(77, f.dependencies);
  expect(f.queries).toEqual([[-77, 0], [-77, 0], [-77, 0]]);
  expect(f.elapsed()).toBe(23);
});

test("a present or reused group exhausts the original deadline without any signal", async () => {
  const f = clock(() => ({ duration: 1 }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.elapsed()).toBe(1000);
  expect(f.queries.length).toBeGreaterThan(1);
  expect(f.queries.every(([pid, signal]) => pid === -77 && signal === 0)).toBe(true);
});

test.each([1000, 1001])("ESRCH returned after %d ms cannot prove absence within the budget", async duration => {
  const f = clock(() => ({ duration, error: absent }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.queries).toEqual([[-77, 0]]);
});

test.each([{ code: "EPERM" }, { code: "EINVAL" }, { code: "EIO" }, {}, null, undefined, "ESRCH"])("unknown or denied query refuses immediately: %j", async error => {
  const f = clock(() => ({ duration: 1, error }));
  await expect(waitForOwnedGroupExit(77, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.queries).toEqual([[-77, 0]]);
});

test.each([0, 1, -1, -77, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid group %s refuses before any query", async group => {
  const f = clock(() => ({ duration: 1, error: absent }));
  await expect(waitForOwnedGroupExit(group, f.dependencies)).rejects.toMatchObject({ diagnostic: { code: "OBSERVER_GROUP" } });
  expect(f.queries).toEqual([]);
});
