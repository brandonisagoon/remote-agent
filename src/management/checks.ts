import { existsSync, readFileSync } from "node:fs";

import { configFilePath, readConfig, type ServerConfig } from "../lib/config.ts";
import { findExecutable, installLayout } from "./paths.ts";
import { run } from "./run.ts";
import { serviceLabel, supervisor } from "./supervisor/index.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  /** What to do about a non-ok status. */
  remedy?: string;
}

/** The full prerequisite/health checklist. One source of truth: the CLI's
    `doctor` prints these, the GUI's Service tables render them. Checks that
    depend on a valid config degrade to a single config failure. */
export async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(toolCheck("bun", "Bun runtime", "install with: brew install oven-sh/bun/bun"));
  results.push(toolCheck("cloudflared", "cloudflared", "install with: brew install cloudflared"));
  results.push(cliCheck());

  let config: ServerConfig;
  try {
    config = readConfig();
    results.push({ id: "config", label: "Configuration", status: "ok", detail: configFilePath() });
  } catch (error) {
    results.push({
      id: "config",
      label: "Configuration",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      remedy: "fix the config file; dependent checks were skipped",
    });
    return results;
  }

  results.push(await serviceCheck(config));
  results.push(await daemonCheck(config));
  results.push(repositoriesCheck(config));
  results.push(await tunnelCheck(config));
  results.push(...providerChecks());

  return results;
}

function toolCheck(name: string, label: string, remedy: string): CheckResult {
  const found = findExecutable(name);
  return found
    ? { id: name, label, status: "ok", detail: found }
    : { id: name, label, status: "fail", remedy };
}

function cliCheck(): CheckResult {
  const found = findExecutable("remote-agent") ??
    (existsSync("/usr/local/bin/remote-agent") ? "/usr/local/bin/remote-agent" : null);
  return found
    ? { id: "cli", label: "CLI on PATH", status: "ok", detail: found }
    : {
        id: "cli",
        label: "CLI on PATH",
        status: "warn",
        remedy: "install via the desktop app's Install CLI, or your package manager",
      };
}

async function serviceCheck(config: ServerConfig): Promise<CheckResult> {
  const registered = await supervisor().registered(serviceLabel(config.serviceName));
  return registered
    ? { id: "service", label: "Service", status: "ok", detail: serviceLabel(config.serviceName) }
    : {
        id: "service",
        label: "Service",
        status: "fail",
        remedy: "run: remote-agent install",
      };
}

async function daemonCheck(config: ServerConfig): Promise<CheckResult> {
  try {
    const response = await fetch(
      `http://${config.hostname}:${config.port}/health`,
      { signal: AbortSignal.timeout(2_000) },
    );
    return response.ok
      ? { id: "daemon", label: "Daemon", status: "ok", detail: `listening on port ${config.port}` }
      : { id: "daemon", label: "Daemon", status: "fail", detail: `health returned ${response.status}` };
  } catch (error) {
    return {
      id: "daemon",
      label: "Daemon",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      remedy: `check ${installLayout(config.installRoot).serviceLog}`,
    };
  }
}

function repositoriesCheck(config: ServerConfig): CheckResult {
  const repositories = Object.values(config.repositories);
  const missing = repositories
    .filter((repository) => !existsSync(repository.root))
    .map((repository) => `${repository.id}: ${repository.root}`);
  return missing.length === 0
    ? { id: "repositories", label: "Repositories", status: "ok", detail: `${repositories.length} configured` }
    : {
        id: "repositories",
        label: "Repositories",
        status: "fail",
        detail: `missing roots:\n${missing.join("\n")}`,
      };
}

async function tunnelCheck(config: ServerConfig): Promise<CheckResult> {
  const cloudflared = findExecutable("cloudflared");
  if (!cloudflared) {
    return { id: "tunnel", label: "Tunnel", status: "warn", remedy: "install cloudflared first" };
  }
  const tunnelName = readTunnelName(config);
  const result = await run(cloudflared, ["tunnel", "list", "--output", "json"]);
  if (!result.ok) {
    return {
      id: "tunnel",
      label: "Tunnel",
      status: "warn",
      detail: "could not list tunnels",
      remedy: "run: cloudflared tunnel login",
    };
  }
  try {
    const tunnels = JSON.parse(result.output) as Array<{ name: string }>;
    return tunnels.some((tunnel) => tunnel.name === tunnelName)
      ? { id: "tunnel", label: "Tunnel", status: "ok", detail: tunnelName }
      : {
          id: "tunnel",
          label: "Tunnel",
          status: "fail",
          detail: `tunnel "${tunnelName}" not found`,
          remedy: `run: cloudflared tunnel create ${tunnelName}`,
        };
  } catch {
    return { id: "tunnel", label: "Tunnel", status: "warn", detail: "unexpected cloudflared output" };
  }
}

function readTunnelName(config: ServerConfig): string {
  try {
    const file = JSON.parse(readFileSync(configFilePath(), "utf8")) as {
      machine?: { installation?: { tunnelName?: string } };
    };
    return file.machine?.installation?.tunnelName ?? config.serviceName;
  } catch {
    return config.serviceName;
  }
}

/** Provider CLIs are peers, not dependencies: we detect them, never install
    them — they carry the user's own credentials and subscriptions. */
function providerChecks(): CheckResult[] {
  let enabled: string[];
  try {
    const file = JSON.parse(readFileSync(configFilePath(), "utf8")) as {
      providers?: Record<string, unknown>;
    };
    enabled = Object.keys(file.providers ?? {});
  } catch {
    enabled = [];
  }
  const binaries: Record<string, string> = { codex: "codex", claude: "claude" };
  return enabled.flatMap((providerId) => {
    const binary = binaries[providerId];
    if (!binary) return [];
    const found = findExecutable(binary);
    return [found
      ? { id: `provider-${providerId}`, label: `Provider: ${providerId}`, status: "ok" as const, detail: found }
      : {
          id: `provider-${providerId}`,
          label: `Provider: ${providerId}`,
          status: "fail" as const,
          remedy: `install and authenticate the ${binary} CLI`,
        }];
  });
}
