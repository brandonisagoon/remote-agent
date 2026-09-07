// The remote-agent MCP server a session discovers as tools. Runs as a stdio
// child of the harness (acpx passes it via the ACP mcpServers list); calls
// back into the server over the control socket. Identity comes from the
// session's environment, injected by the server at launch.
import { createInterface } from "node:readline";

const sessionId = process.env.REMOTE_AGENT_SESSION_ID;
const socketPath = process.env.REMOTE_AGENT_SOCKET;
if (!sessionId || !socketPath) {
  console.error("REMOTE_AGENT_SESSION_ID and REMOTE_AGENT_SOCKET are required");
  process.exit(1);
}

type Json = Record<string, unknown>;

async function call(method: string, route: string, body?: Json): Promise<Json> {
  const response = await fetch(`http://remote-agent${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    // Bun: route the request over the unix socket instead of the network.
    unix: socketPath,
  } as RequestInit & { unix: string });
  const json = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) {
    throw new Error(typeof json.error === "string" ? json.error : `HTTP ${response.status}`);
  }
  return json;
}

const TOOLS = [
  {
    name: "delegate_session",
    description:
      "Start a child agent session that inherits this session's repository, worktree, and issue. Use it to hand off a bounded sub-task (research, a parallel implementation slice, a review). The child works in the same worktree on the same issue; replies in threads it registers route to it. Returns the child's session id.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The child's full instruction." },
        provider: { type: "string", enum: ["codex", "claude"], description: "Defaults to this session's provider." },
        model: { type: "string" },
        name: { type: "string", description: "Short label shown in session lists." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "register_thread",
    description:
      "Register a comment thread this session owns so replies in it are delivered here without a mention. Use relationship \"question\" when the comment asks the human something; their reply then arrives framed as the answer.",
    inputSchema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
        relationship: { type: "string", enum: ["thread", "question"] },
      },
      required: ["commentId"],
      additionalProperties: false,
    },
  },
] as const;

async function callTool(name: string, args: Json): Promise<Json> {
  if (name === "delegate_session") {
    return call("POST", `/api/sessions/${sessionId}/delegate`, args);
  }
  if (name === "register_thread") {
    return call("PUT", `/api/sessions/${sessionId}/threads`, args);
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request: { jsonrpc?: string; id?: string | number; method?: string; params?: Json };
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return; // notifications
  const base = { jsonrpc: "2.0" as const, id: request.id };

  if (request.method === "initialize") {
    send({
      ...base,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "remote-agent", version: "1.0.0" },
        instructions:
          "Remote Agent session tools. delegate_session hands a sub-task to a child session on the same issue and worktree; register_thread makes replies in a comment thread route to this session.",
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({ ...base, result: { tools: TOOLS } });
    return;
  }
  if (request.method === "tools/call") {
    const params = (request.params ?? {}) as { name?: string; arguments?: Json };
    void callTool(params.name ?? "", params.arguments ?? {})
      .then((result) =>
        send({
          ...base,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        }),
      )
      .catch((error: unknown) =>
        send({
          ...base,
          result: {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
        }),
      );
    return;
  }
  send({ ...base, error: { code: -32601, message: `unknown method: ${request.method}` } });
});
