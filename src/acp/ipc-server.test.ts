import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { testConfig } from "../test-support/config.ts";
import { createFakeAgentRuntime } from "../test-support/agent-runtime.ts";
import { startAcpIpcServer } from "./ipc-server.ts";

describe("ACP daemon IPC", () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("rejects a second listener and removes its socket on shutdown", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "remote-agent-ipc-"));
    const socketPath = path.join(directory, "daemon.sock");
    const config = testConfig({ acpIpcPath: socketPath });
    const server = await startAcpIpcServer({
      config,
      runtime: createFakeAgentRuntime(),
    });
    try {
      await expect(startAcpIpcServer({
        config,
        runtime: createFakeAgentRuntime(),
      })).rejects.toThrow("another Remote Agent daemon owns");
    } finally {
      await server.close();
    }
    expect(await Bun.file(socketPath).exists()).toBe(false);
  });
});
