import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { remoteAgentMcpServer } from "../../apps/server/mcp/register.ts";

describe("remote-agent MCP server registration", () => {
  test("points at a script that exists in this tree", () => {
    const server = remoteAgentMcpServer();
    expect(server.name).toBe("remote-agent");
    expect(existsSync(server.args[0]!)).toBeTrue();
  });
});
