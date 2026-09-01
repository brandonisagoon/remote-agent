import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readConfig, routeWebhookRepository } from "./config.ts";

let directory: string;
let previousConfig: string | undefined;

function serviceFile(zedConnection: "local" | "ssh" = "local") {
  return {
    serviceName: "example-agent",
    server: {
      publicUrl: "https://agents.example.com",
      apiKey: "api-secret",
      databaseUrl: "file:./state.sqlite",
      githubWebhookSecret: "github-secret",
      webhooks: {
        "linear-main": {
          connection: "linear-main",
          webhookSecret: "webhook-secret",
          repositoryRouting: { example: {} },
        },
      },
    },
    acpx: {},
    connections: {
      "linear-main": {
        provider: "linear",
        apiKey: "linear-secret",
        agentUserId: "agent-user",
      },
      "linear-second": {
        provider: "linear",
        apiKey: "linear-secret-2",
        agentUserId: "agent-user-2",
      },
    },
    hosts: [
      {
        id: "build-host",
        label: "Build Host",
        zedConnection,
        acceptsTrackerInput: true,
        default: true,
      },
    ],
    repositories: {
      example: {
        root: "repository",
        worktreeRoot: "../worktrees",
        bootstrapCommand: ["bash", "scripts/bootstrap.sh"],
        metadata: {
          tags: {
            "example.kind": {
              options: ["planning", "implementation"],
              cardinality: "one",
              routerVisible: true,
            },
          },
        },
        sessionDefaults: { tags: { "example.kind": ["planning"] } },
        workflows: {
          describe: {
            prompt: "prompts/describe.md",
            harness: "claude",
            model: "opus",
          },
          orchestrate: {
            prompt: "prompts/orchestrate.md",
            harness: "codex",
          },
          reflect: { prompt: "prompts/reflect.md" },
        },
      },
    },
  };
}

function writeConfig(value: unknown = serviceFile()) {
  const file = path.join(directory, "remote-agent.config.json");
  writeFileSync(file, JSON.stringify(value));
  process.env.REMOTE_AGENT_CONFIG = file;
  return file;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "remote-agent-config-"));
  previousConfig = process.env.REMOTE_AGENT_CONFIG;
  delete process.env.REMOTE_AGENT_CONFIG;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.REMOTE_AGENT_CONFIG;
  else process.env.REMOTE_AGENT_CONFIG = previousConfig;
  rmSync(directory, { recursive: true, force: true });
});

describe("readConfig", () => {
  test("loads all settings from one JSON file and derives neutral paths", () => {
    writeConfig();
    const config = readConfig();

    expect(config.serviceName).toBe("example-agent");
    expect(config.machine).toBe("build-host");
    expect(config.hosts[0]).toMatchObject({ label: "Build Host" });
    expect(config.publicUrl).toBe("https://agents.example.com");
    expect(config.linearApiKey).toBe("linear-secret");
    expect(config.deployJobLabel).toBe("dev.example-agent.deploy");
    expect(Object.keys(config.connections)).toEqual(["linear-main", "linear-second"]);
    expect(config.activeConnectionId).toBe("linear-main");
    expect(config.repository.id).toBe("example");
    expect(config.repository.root).toBe(path.join(directory, "repository"));
    expect(config.repository.worktreeRoot).toBe(path.join(directory, "worktrees"));
    expect(config.databaseUrl).toBe(`file:${path.join(directory, "state.sqlite")}`);
  });

  test("requires settings formerly supplied by the environment", () => {
    const value = serviceFile();
    // @ts-expect-error exercising runtime validation
    delete value.server.publicUrl;
    writeConfig(value);
    expect(() => readConfig()).toThrow("publicUrl");
  });

  test("requires a Zed host only for SSH execution hosts", () => {
    const value = serviceFile("ssh");
    writeConfig(value);
    expect(() => readConfig()).toThrow("runtime.zedRemoteHost is required");

    writeConfig({
      ...value,
      runtime: { zedRemoteHost: "build-host.example" },
    });
    expect(readConfig().zedRemoteHost).toBe("build-host.example");
  });

  test("rejects a selected machine absent from the host registry", () => {
    writeConfig({ ...serviceFile(), runtime: { machine: "unknown-host" } });
    expect(() => readConfig()).toThrow("unknown machine: unknown-host");
  });

  test("keeps tag definitions repository-specific", () => {
    const value: any = serviceFile();
    value.repositories.second = {
      ...value.repositories.example,
      root: "second",
      worktreeRoot: "../second-worktrees",
      metadata: {
        tags: {
          "example.kind": {
            options: ["review"],
            cardinality: "many",
            routerVisible: false,
          },
        },
      },
      sessionDefaults: { tags: { "example.kind": ["review"] } },
    };
    writeConfig(value);
    const config = readConfig();
    expect(config.repositories.example.metadata.tags["example.kind"]?.options).toEqual([
      "planning",
      "implementation",
    ]);
    expect(config.repositories.second.metadata.tags["example.kind"]?.options).toEqual([
      "review",
    ]);
  });

  test("rejects routing outside a webhook repository allowlist", () => {
    const value: any = serviceFile();
    value.server.webhooks["linear-main"].repositoryRouting = {
      missing: { when: [{ "linear.teamId": ["team"] }] },
    };
    writeConfig(value);
    expect(() => readConfig()).toThrow("unknown repository");
  });

  test("routes one webhook across repositories with OR/AND/value semantics", () => {
    const value: any = serviceFile();
    value.repositories.second = {
      ...value.repositories.example,
      root: "second",
      worktreeRoot: "../second-worktrees",
    };
    value.server.webhooks["linear-main"].repositoryRouting = {
      example: {
        when: [
          {
            "linear.teamId": ["team-product"],
            "linear.projectId": ["project-one", "project-two"],
          },
          { "linear.teamId": ["team-platform"] },
        ],
      },
      second: { when: [{ "linear.teamId": ["team-second"] }] },
    };
    writeConfig(value);
    const config = readConfig();

    expect(routeWebhookRepository(config, "linear-main", {
      "linear.teamId": "team-product",
      "linear.projectId": "project-two",
    }).id).toBe("example");
    expect(routeWebhookRepository(config, "linear-main", {
      "linear.teamId": "team-platform",
    }).id).toBe("example");
    expect(routeWebhookRepository(config, "linear-main", {
      "linear.teamId": "team-second",
    }).id).toBe("second");
  });

  test("rejects ambiguous repository routing", () => {
    const value: any = serviceFile();
    value.repositories.second = {
      ...value.repositories.example,
      root: "second",
      worktreeRoot: "../second-worktrees",
    };
    value.server.webhooks["linear-main"].repositoryRouting = {
      example: { when: [{ "linear.teamId": ["shared"] }] },
      second: { when: [{ "linear.teamId": ["shared"] }] },
    };
    writeConfig(value);
    const config = readConfig();
    expect(() => routeWebhookRepository(config, "linear-main", {
      "linear.teamId": "shared",
    })).toThrow("matched multiple repositories");
  });

  test("allows an unconditional target only when it is the sole target", () => {
    const value: any = serviceFile();
    value.repositories.second = {
      ...value.repositories.example,
      root: "second",
      worktreeRoot: "../second-worktrees",
    };
    value.server.webhooks["linear-main"].repositoryRouting.second = {
      when: [{ "linear.teamId": ["team-second"] }],
    };
    writeConfig(value);
    expect(() => readConfig()).toThrow("unconditional target");
  });

  test("keeps multiple Linear connection credentials independent", () => {
    writeConfig();
    const config = readConfig();
    expect(config.connections["linear-main"]?.apiKey).toBe("linear-secret");
    expect(config.connections["linear-second"]?.apiKey).toBe("linear-secret-2");
    expect(config.connections["linear-main"]).not.toHaveProperty("agentTeamKey");
  });
});
