import { expect, test, spyOn } from "bun:test";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";

test("session and health requests progress while owned group absence is pending", async () => {
  const query = process.kill;
  let observing!: () => void;
  const observed = new Promise<void>(resolve => { observing = resolve; });
  let held = true, ownedGroup: number | undefined, inspections = 0;
  const release = () => { held = false; };
  const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < -1 && signal === 0) {
      ownedGroup ??= pid;
      if (pid === ownedGroup) {
        inspections++;
        observing();
        // Keep this group's absence unproven until release. The real bounded
        // polling loop must yield so unrelated requests can still progress.
        if (held) return true;
      }
    }
    return query(pid, signal);
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ready: true }) });
  let settled = false;
  const result = executeOwnedObserver([process.execPath, "--no-env-file", "-e", 'console.log("observed")'], { cwd: process.cwd(), timeoutMs: 5000 });
  void result.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.race([observed, Bun.sleep(3000).then(() => { throw Error("inspection not reached"); })]);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(500) });
    expect(await response.json()).toEqual({ ready: true });
    expect(settled).toBeFalse();
    release();
    expect((await result).trim()).toBe("observed");
    expect(inspections).toBeGreaterThan(1);
  } finally {
    release(); await result.catch(() => {}); spy.mockRestore(); await server.stop(true);
  }
}, 10000);
