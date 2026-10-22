import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";

export interface AcpEndpoint {
  name: string;
  roots: string[];
  connection: acp.ClientSideConnection;
}

/** Routes by the server's existing session ID, never by a session's current cwd. */
export class MultiServerAcpAgent implements acp.Agent {
  private readonly owners = new Map<string, AcpEndpoint>();

  constructor(private readonly endpoints: AcpEndpoint[]) {
    if (!endpoints.length) throw new Error("At least one ACP server is required");
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const responses = await Promise.all(this.endpoints.map(async (endpoint) => {
      const response = await endpoint.connection.initialize(params);
      if (response.protocolVersion !== acp.PROTOCOL_VERSION ||
          !response.agentCapabilities?.sessionCapabilities?.list ||
          response.authMethods?.length) {
        throw acp.RequestError.internalError(undefined, `${endpoint.name}: combined connections require a compatible, locally authenticated Remote Agent server with session/list`);
      }
      return response.agentCapabilities!;
    }));
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "remote-agent", title: "Remote Agent", version: "0.1.0" },
      agentCapabilities: {
        loadSession: responses.every((caps) => caps.loadSession),
        promptCapabilities: {
          image: responses.every((caps) => caps.promptCapabilities?.image),
          audio: responses.every((caps) => caps.promptCapabilities?.audio),
          embeddedContext: responses.every((caps) => caps.promptCapabilities?.embeddedContext),
        },
        mcpCapabilities: {
          http: responses.every((caps) => caps.mcpCapabilities?.http),
          sse: responses.every((caps) => caps.mcpCapabilities?.sse),
        },
        sessionCapabilities: {
          list: {},
          ...(responses.every((caps) => caps.sessionCapabilities?.resume) ? { resume: {} } : {}),
          ...(responses.every((caps) => caps.sessionCapabilities?.close) ? { close: {} } : {}),
        },
      },
    };
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    await Promise.all(this.endpoints.map((endpoint) => endpoint.connection.authenticate(params)));
    return {};
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    if (params.cursor) throw acp.RequestError.invalidParams(undefined, "The combined session list is returned in one page");
    const pages = await Promise.all(this.endpoints.map(async (endpoint) => {
      const sessions: acp.SessionInfo[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await endpoint.connection.listSessions({ ...params, cwd: undefined, cursor });
        sessions.push(...page.sessions);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw acp.RequestError.internalError(undefined, `${endpoint.name}: repeated session list cursor`);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { endpoint, sessions };
    }));
    // Validate the whole result before publishing any newly discovered bindings.
    const owners = new Map(this.owners);
    for (const { endpoint, sessions } of pages) {
      for (const session of sessions) this.bind(owners, session.sessionId, endpoint);
    }
    for (const [id, endpoint] of owners) this.owners.set(id, endpoint);
    return {
      sessions: pages.flatMap((page) => page.sessions).filter((session) => !params.cwd || session.cwd === params.cwd).sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.sessionId.localeCompare(b.sessionId)),
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const endpoint = this.endpointForDirectory(params.cwd);
    const result = await endpoint.connection.newSession(params);
    this.bind(this.owners, result.sessionId, endpoint);
    return result;
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return (await this.owner(params.sessionId)).connection.loadSession(params);
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    return (await this.owner(params.sessionId)).connection.resumeSession(params);
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    return (await this.owner(params.sessionId)).connection.closeSession(params);
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return (await this.owner(params.sessionId)).connection.setSessionMode(params);
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    return (await this.owner(params.sessionId)).connection.setSessionConfigOption(params);
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return (await this.owner(params.sessionId)).connection.prompt(params);
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    await (await this.owner(params.sessionId)).connection.cancel(params);
  }

  private async owner(sessionId: string): Promise<AcpEndpoint> {
    if (!this.owners.has(sessionId)) await this.listSessions({});
    const endpoint = this.owners.get(sessionId);
    if (!endpoint) throw acp.RequestError.invalidParams(undefined, `Unknown Remote Agent session: ${sessionId}`);
    return endpoint;
  }

  private bind(owners: Map<string, AcpEndpoint>, id: string, endpoint: AcpEndpoint): void {
    const existing = owners.get(id);
    if (existing && existing !== endpoint) {
      throw acp.RequestError.internalError(undefined, `Ambiguous session ${id} exists on ${existing.name} and ${endpoint.name}`);
    }
    owners.set(id, endpoint);
  }

  private endpointForDirectory(cwd: string): AcpEndpoint {
    const matches = this.endpoints.flatMap((endpoint) => endpoint.roots.flatMap((root) => {
      const absolute = path.resolve(root);
      const relative = path.relative(absolute, path.resolve(cwd));
      const within = relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      return within ? [{ endpoint, specificity: absolute.length }] : [];
    })).sort((a, b) => b.specificity - a.specificity);
    const best = matches[0];
    if (!best) throw acp.RequestError.invalidParams(undefined, `No configured Remote Agent repository owns ${cwd}`);
    if (matches.some((match) => match.specificity === best.specificity && match.endpoint !== best.endpoint)) {
      throw acp.RequestError.invalidParams(undefined, `Multiple Remote Agent servers own ${cwd}`);
    }
    return best.endpoint;
  }
}
