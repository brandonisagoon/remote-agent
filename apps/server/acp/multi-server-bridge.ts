import { createConnection, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import type { ServerConfig } from "../../../lib/config.ts";
import { MultiServerAcpAgent, type AcpEndpoint } from "./multi-server-agent.ts";

/** Forward client callbacks through the SDK so upstream request IDs cannot collide. */
function forwardClient(client: acp.AgentSideConnection): acp.Client {
  return {
    sessionUpdate: (params) => client.sessionUpdate(params),
    requestPermission: (params) => client.requestPermission(params),
    readTextFile: (params) => client.readTextFile(params),
    writeTextFile: (params) => client.writeTextFile(params),
    createTerminal: (params) => client.request("terminal/create", params),
    terminalOutput: (params) => client.request("terminal/output", params),
    releaseTerminal: (params) => client.request("terminal/release", params),
    waitForTerminalExit: (params) => client.request("terminal/wait_for_exit", params),
    killTerminal: (params) => client.request("terminal/kill", params),
    createElicitation: (params) => client.createElicitation(params),
    completeElicitation: (params) => client.completeElicitation(params),
    extMethod: (method, params) => client.extMethod(method, params),
    extNotification: (method, params) => client.extNotification(method, params),
  };
}

async function connect(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw new Error(`Cannot connect to Remote Agent at ${socketPath}`, { cause: error });
  }
}

export async function startMultiServerBridge(
  configs: ServerConfig[],
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  if (new Set(configs.map((config) => config.acpIpcPath)).size !== configs.length) {
    throw new Error("Each Remote Agent ACP config must point to a different server socket");
  }
  const sockets: Socket[] = [];
  try {
    for (const config of configs) sockets.push(await connect(config.acpIpcPath));
    const endpoints: AcpEndpoint[] = [];
    const client = new acp.AgentSideConnection((client) => {
      configs.forEach((config, index) => {
        const socket = sockets[index]!;
        endpoints.push({
          name: config.configFile,
          roots: Object.values(config.repositories).flatMap((repo) => [repo.root, repo.worktreeRoot]),
          connection: new acp.ClientSideConnection(() => forwardClient(client), acp.ndJsonStream(
            Writable.toWeb(socket),
            Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>,
          )),
        });
      });
      return new MultiServerAcpAgent(endpoints);
    }, acp.ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as unknown as ReadableStream<Uint8Array>));
    await Promise.race([
      client.closed,
      ...endpoints.map(async (endpoint) => {
        await endpoint.connection.closed;
        throw new Error(`Remote Agent disconnected: ${endpoint.name}. Reconnect the ACP client after restarting that server.`);
      }),
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    input.destroy();
    output.end();
  }
}
