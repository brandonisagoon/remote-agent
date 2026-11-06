/**
 * DRA-37 fail-closed process checks for the fixture's guard and barrier
 * processes (used by dra37-fixture.ts cleanup and the collection runner).
 * Read-only: nothing is ever signalled except signal 0 (existence probe).
 *
 * Only ESRCH proves a process is gone. A failed `ps` read is never proof of
 * exit: it is re-probed, and anything but ESRCH is reported as unknown.
 *
 * Process identity is the exact guard SHIM path (`<fixture root>/bin/docker`),
 * which is what the OS command line actually shows (`bun --no-env-file
 * <shim> …`). The policy path is spliced into process.argv inside the JS
 * process only and is NEVER visible to `ps`.
 */
import path from "node:path";

/** The executable guard shim, shared by the fixture and its tests: a Bun
 * script that passes the policy (in-process argv only) to the guard. */
export function guardShimSource(policyPath: string) {
  return [`#!${process.execPath} --no-env-file`,
    `process.argv.splice(2, 0, ${JSON.stringify(policyPath)});`,
    `await import(${JSON.stringify(path.join(import.meta.dir, "dra37-docker-guard.ts"))});`, ""].join("\n");
}

export type ProcessState = "gone" | "exists" | "unknown";
export type Probe = {
  /** `ps` with the given arguments; `code` is its exit status. */
  ps(args: string[]): { code: number | null; stdout: string };
  /** Existence probe for one PID (signal 0). */
  state(pid: number): ProcessState;
};

export const systemProbe: Probe = {
  ps(args) { const result = Bun.spawnSync(["ps", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: result.exitCode, stdout: result.stdout.toString() }; },
  state(pid) {
    try { process.kill(pid, 0); return "exists"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
  },
};

/** Live guard processes of this fixture (OS argv contains its exact shim path), or
 * null when the process inventory could not be read. */
export function guardInventory(shimPath: string, probe: Probe = systemProbe): string[] | null {
  const result = probe.ps(["-axo", "pid=,command="]);
  if (result.code !== 0) return null;
  return result.stdout.split("\n").filter(line => line.includes(shimPath) && !line.includes("ps -axo"));
}

/** Each exactly recorded barrier PID: gone (ESRCH), a reused PID whose OS
 * argv no longer contains this fixture's shim, still ours (live), or unknown. */
export function recordedBarriers(pids: number[], shimPath: string, probe: Probe = systemProbe) {
  const live: string[] = [], unknown: string[] = [];
  for (const pid of pids) {
    if (probe.state(pid) === "gone") continue;
    const identity = probe.ps(["-o", "command=", "-p", String(pid)]);
    if (identity.code === 0) { if (identity.stdout.includes(shimPath)) live.push(`${pid}: ${identity.stdout.trim()}`); continue; }
    // The identity read failed: that is not proof of exit. Re-probe.
    const again = probe.state(pid);
    if (again !== "gone") unknown.push(`${pid}: identity unreadable (ps exit ${identity.code}), process ${again}`);
  }
  return { live, unknown };
}

/** Bounded drain: waits until no guard of this fixture is running and every
 * recorded barrier PID is provably gone; otherwise returns the problems. */
export async function drainGuards(input: { shimPath: string; barrierPids: number[]; boundMs: number; probe?: Probe; sleep?: (ms: number) => Promise<unknown>; now?: () => number }) {
  const probe = input.probe ?? systemProbe, sleep = input.sleep ?? Bun.sleep, now = input.now ?? Date.now;
  const deadline = now() + input.boundMs;
  let guards = guardInventory(input.shimPath, probe);
  while ((guards === null || guards.length) && now() < deadline) { await sleep(250); guards = guardInventory(input.shimPath, probe); }
  const barriers = recordedBarriers(input.barrierPids, input.shimPath, probe);
  const problems: string[] = [];
  if (guards === null) problems.push("guard process inventory (ps) failed; exact cleanup cannot be claimed");
  else if (guards.length) problems.push(`guard processes still running after the drain bound; exact cleanup cannot be claimed: ${guards.join(" | ")}`);
  if (barriers.live.length) problems.push(`recorded barrier processes still alive: ${barriers.live.join(" | ")}`);
  if (barriers.unknown.length) problems.push(`recorded barrier processes in an unknown state: ${barriers.unknown.join(" | ")}`);
  return { problems, guards, ...barriers, recordedBarrierPids: input.barrierPids.length };
}
