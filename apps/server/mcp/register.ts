import path from "node:path";

import type { McpServerStdio } from "@agentclientprotocol/sdk";

import { findExecutable, sourceRoot } from "../../../management/paths.ts";

/** Base MCP descriptor. The runtime supplies explicit session identity in
    its env list because providers sanitize inherited MCP environments. */
export function remoteAgentMcpServer(): McpServerStdio {
  const bun = findExecutable("bun") ?? "bun";
  return {
    name: "remote-agent",
    command: bun,
    args: [path.join(sourceRoot(), "apps", "server", "mcp", "remote-agent-mcp.ts")],
    env: [],
  };
}
