import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { dra37Server } from "./dra37-fixture.ts";

// Real server process, provider process and git worktrees on a loaded host.
setDefaultTimeout(180_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (done(last)) return last; await Bun.sleep(100); }
  const text = JSON.stringify(last) ?? "";
  throw new Error(`Timed out waiting for ${label}: ${text.slice(0, 600)} … ${text.slice(-1_200)}`);
}

test("a filled budget holds closed, paused and eligible waiters; the original primary redeems its offer through normal routes", async () => {
  const server = await dra37Server({ slots: 1 });
  cleanups.push(() => server.cleanup({ keepEvidence: !!process.env.DRA37_KEEP_EVIDENCE }));
  const first = await server.seedTask("first");
  const closed = await server.seedTask("closed", { phase: "closed" });
  const paused = await server.seedTask("paused", { ownerPaused: true });
  const eligible = await server.seedTask("eligible");
  await server.start();
  const prisma = server.db.prisma;

  // 1) The first request fills the single slot: reserved, delivered to its
  //    original primary, redeemed in that turn via compute-claim.
  const firstRequest = await server.requestCompute(first);
  expect(firstRequest.status).toBe(202);
  const claim = await until(server.agentEvents, events => events.some(event => event.event === "claim" || event.event === "claim-error" || event.event === "claim-skipped"), "first claim");
  const claimed = claim.find(event => String(event.event).startsWith("claim"))!;
  expect(claimed).toMatchObject({ event: "claim", task: first.id, status: 200 });
  const firstOffer = await prisma.computeOffer.findFirstOrThrow({ where: { environmentId: (await prisma.computeEnvironment.findFirstOrThrow({ where: { taskId: first.id } })).id } });
  expect(["claimed", "running"]).toContain(firstOffer.state);
  expect(await prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);

  // 2) Waiters while the budget is full: closed and paused are not eligible;
  //    the eligible one waits without an offer.
  for (const task of [closed, paused, eligible]) expect((await server.requestCompute(task)).status).not.toBe(500);
  await Bun.sleep(3_000);
  const offers = await prisma.computeOffer.findMany();
  const environments = await prisma.computeEnvironment.findMany();
  const byTask = (taskId: string) => environments.find(environment => environment.taskId === taskId);
  expect(offers.filter(offer => offer.environmentId !== byTask(first.id)?.id)).toEqual([]);
  expect(await prisma.computeSlot.count({ where: { allocationId: { not: null } } })).toBe(1);

  // 3) Ordinary inbox delivery continues while compute waits.
  const ordinary = await prisma.runtimeInstruction.create({ data: { id: `dra37-ordinary-${crypto.randomUUID()}`, sessionId: eligible.sessionId, text: "ordinary follow-up while compute waits" } });
  await until(() => prisma.runtimeInstruction.findUniqueOrThrow({ where: { id: ordinary.id } }), row => row.state === "completed", "ordinary delivery");
  expect((await server.agentEvents()).some(event => event.event === "prompt" && event.task === eligible.id && String(event.text).includes("ordinary follow-up"))).toBe(true);
  console.log(JSON.stringify({ evidence: { root: server.root, pid: server.pid, firstOffer: firstOffer.id, environments: environments.map(environment => ({ id: environment.id, task: environment.taskId, state: environment.state })) } }));
});
