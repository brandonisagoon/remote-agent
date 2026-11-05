import { expect, test, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { executeOwnedObserver } from "./cleanup-resource-observer.ts";

test("session and health requests progress while group-exit inspection is slow", async () => {
  const original = childProcess.execFile;
  let observing!: () => void;
  const observed = new Promise<void>(resolve => { observing = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const spy = spyOn(childProcess, "execFile").mockImplementation(((...args: any[]) => {
    if (args[0] !== "/bin/ps") return (original as any)(...args);
    const callback = args.at(-1);
    observing();
    // Delay delivery of the real process-table observation, not its contents.
    return (original as any)(...args.slice(0, -1), (...result: any[]) => {
      void held.then(() => callback(...result));
    });
  }) as any);
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
  } finally {
    release(); await result.catch(() => {}); spy.mockRestore(); await server.stop(true);
  }
}, 10000);
