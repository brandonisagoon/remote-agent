import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readConfig } from "./config.ts";

let directory: string;
let previousConfig: string | undefined;

function serviceFile(zedConnection: "local" | "ssh" = "local") {
  return {
    serviceName: "example-agent",
    server: {
      publicUrl: "https://agents.example.com",
      apiKey: "api-secret",
      databaseUrl: "file:./state.sqlite",
    },
    acpx: { reconcileIntervalMs: 45_000 },
    linear: {
      webhookSecret: "webhook-secret",
      apiKey: "linear-secret",
      agentUserId: "agent-user",
    },
    github: { webhookSecret: "github-secret" },
    hosts: [
      {
        id: "build-host",
        label: "Build Host",
        zedConnection,
        acceptsTrackerInput: true,
        default: true,
      },
    ],
    repository: {
      root: "repository",
      worktreeRoot: "../worktrees",
      bootstrapCommand: ["bash", "scripts/bootstrap.sh"],
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
    expect(config.acpxReconcileIntervalMs).toBe(45_000);
    expect(config.deployJobLabel).toBe("dev.example-agent.deploy");
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
});
