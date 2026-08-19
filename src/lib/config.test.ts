import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readConfig } from "./config.ts";

const MANAGED_ENV = [
  "REMOTE_AGENT_CONFIG",
  "REMOTE_AGENT_PUBLIC_URL",
  "REMOTE_AGENT_INSTALL_ROOT",
  "REMOTE_AGENT_MACHINE",
  "REMOTE_AGENT_ZED_HOST",
  "LINEAR_WEBHOOK_SECRET",
  "REMOTE_AGENT_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_AGENT_USER_ID",
  "REMOTE_AGENT_BB_PROJECT_ID",
] as const;

let directory: string;
let previous: Partial<Record<(typeof MANAGED_ENV)[number], string>>;

function serviceFile(zedConnection: "local" | "ssh" = "local") {
  return {
    serviceName: "example-agent",
    hosts: [
      {
        id: "build-host",
        label: "Build Host",
        bbHostId: "bb_host_1",
        zedConnection,
        acceptsTrackerInput: true,
        default: true,
      },
    ],
    repository: {
      root: path.join(directory, "repository"),
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

function writeConfig(value = serviceFile()) {
  const file = path.join(directory, "remote-agent.config.json");
  writeFileSync(file, JSON.stringify(value));
  process.env.REMOTE_AGENT_CONFIG = file;
  return file;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "remote-agent-config-"));
  previous = {};
  for (const name of MANAGED_ENV) {
    if (process.env[name] !== undefined) previous[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, {
    REMOTE_AGENT_PUBLIC_URL: "https://agents.example.com",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    REMOTE_AGENT_API_KEY: "api-secret",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    LINEAR_API_KEY: "linear-secret",
    LINEAR_AGENT_USER_ID: "agent-user",
    REMOTE_AGENT_BB_PROJECT_ID: "bb-project",
  });
});

afterEach(() => {
  for (const name of MANAGED_ENV) delete process.env[name];
  Object.assign(process.env, previous);
  rmSync(directory, { recursive: true, force: true });
});

describe("readConfig", () => {
  test("loads arbitrary hosts and derives neutral service paths", () => {
    writeConfig();
    const config = readConfig();

    expect(config.serviceName).toBe("example-agent");
    expect(config.machine).toBe("build-host");
    expect(config.hosts[0]).toMatchObject({
      label: "Build Host",
      bbHostId: "bb_host_1",
    });
    expect(config.deployJobLabel).toBe("dev.example-agent.deploy");
    expect(config.repository.worktreeRoot).toBe(
      path.join(directory, "worktrees"),
    );
  });

  test("requires an explicit public URL", () => {
    writeConfig();
    delete process.env.REMOTE_AGENT_PUBLIC_URL;
    expect(() => readConfig()).toThrow("REMOTE_AGENT_PUBLIC_URL is required");
  });

  test("requires a Zed host only for SSH execution hosts", () => {
    writeConfig(serviceFile("ssh"));
    expect(() => readConfig()).toThrow("REMOTE_AGENT_ZED_HOST is required");
    process.env.REMOTE_AGENT_ZED_HOST = "build-host.example";
    expect(readConfig().zedRemoteHost).toBe("build-host.example");
  });

  test("rejects a selected machine absent from the host registry", () => {
    writeConfig();
    process.env.REMOTE_AGENT_MACHINE = "unknown-host";
    expect(() => readConfig()).toThrow("unknown machine: unknown-host");
  });
});
