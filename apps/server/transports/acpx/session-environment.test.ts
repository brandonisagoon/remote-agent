import { describe, expect, test } from "bun:test";

import { sessionEnvironment } from "./session-runtime.ts";

describe("sessionEnvironment", () => {
  test("injects the session id and control socket, preserving caller env", () => {
    expect(
      sessionEnvironment("runtime-1", { controlIpcPath: "/tmp/control.sock" }, { FOO: "bar" }),
    ).toEqual({
      FOO: "bar",
      REMOTE_AGENT_SESSION_ID: "runtime-1",
      REMOTE_AGENT_SOCKET: "/tmp/control.sock",
    });
  });
});
