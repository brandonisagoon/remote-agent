import path from "node:path";

import type { McpServerStdio } from "@agentclientprotocol/sdk";

import { findExecutable, sourceRoot } from "../../../management/paths.ts";

/** The MCP server every session gets: acpx passes it to the harness, which
    spawns it per session with the session's environment (where the server
    injected REMOTE_AGENT_SESSION_ID and REMOTE_AGENT_SOCKET). */
export function remoteAgentMcpServer(): McpServerStdio {
  const bun = findExecutable("bun") ?? "bun";
  return {
    name: "remote-agent",
    command: bun,
    args: [path.join(sourceRoot(), "apps", "server", "mcp", "remote-agent-mcp.ts")],
    env: [],
  };
}
