import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";

import { configFilePath, readConfig, type ServerConfig } from "../lib/config.ts";
import { findExecutable, installLayout } from "./paths.ts";
import { run } from "./run.ts";
import { resolveCname } from "node:dns/promises";
import { listTunnels, tunnelHost, tunnelLabel, tunnelLoginCert, tunnelName } from "./tunnel.ts";
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
  results.push(await serverCheck(config));
  results.push(await acpSocketCheck(config));
  results.push(repositoriesCheck(config));
  results.push(...(await tunnelChecks(config)));
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

async function serverCheck(config: ServerConfig): Promise<CheckResult> {
  try {
    const response = await fetch(
      `http://${config.hostname}:${config.port}/health`,
      { signal: AbortSignal.timeout(2_000) },
    );
    return response.ok
      ? { id: "server", label: "Server", status: "ok", detail: `listening on port ${config.port}` }
      : { id: "server", label: "Server", status: "fail", detail: `health returned ${response.status}` };
  } catch (error) {
    return {
      id: "server",
      label: "Server",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      remedy: `check ${installLayout(config.installRoot).serviceLog}`,
    };
  }
}

/** The socket ACP clients (Zed, bb, T3 Code) reach sessions through. */
async function acpSocketCheck(config: ServerConfig): Promise<CheckResult> {
  if (!existsSync(config.acpIpcPath)) {
    return {
      id: "acp",
      label: "ACP Socket",
      status: "fail",
      detail: config.acpIpcPath,
      remedy: "start the server; it creates the socket on boot",
    };
  }
  const listening = await new Promise<boolean>((resolve) => {
    const socket = createConnection(config.acpIpcPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1_000);
  });
  return listening
    ? { id: "acp", label: "ACP Socket", status: "ok", detail: config.acpIpcPath }
    : {
        id: "acp",
        label: "ACP Socket",
        status: "fail",
        detail: `socket exists but is not accepting connections: ${config.acpIpcPath}`,
        remedy: "restart the server",
      };
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

/** The tunnel as five facts, each with the one command that fixes all of
    them: `remote-agent tunnel` is idempotent. */
async function tunnelChecks(config: ServerConfig): Promise<CheckResult[]> {
  const cloudflared = findExecutable("cloudflared");
  const remedy = "run: remote-agent tunnel";
  const name = tunnelName(config);
  const host = tunnelHost(config);
  const results: CheckResult[] = [];

  const loggedIn = existsSync(tunnelLoginCert());
  results.push(
    loggedIn
      ? { id: "tunnel-login", label: "Cloudflare login", status: "ok", detail: tunnelLoginCert() }
      : { id: "tunnel-login", label: "Cloudflare login", status: "fail", remedy },
  );

  const tunnels = cloudflared && loggedIn ? await listTunnels(cloudflared) : null;
  const tunnel = tunnels?.find((entry) => entry.name === name) ?? null;
  results.push(
    tunnel
      ? { id: "tunnel", label: "Tunnel", status: "ok", detail: name }
      : { id: "tunnel", label: "Tunnel", status: loggedIn ? "fail" : "warn", detail: `tunnel "${name}" not found`, remedy },
  );

  let routed = false;
  if (tunnel) {
    try {
      const records = await resolveCname(host);
      routed = records.some((record) => record === `${tunnel.id}.cfargotunnel.com`);
    } catch {
      routed = false;
    }
  }
  results.push(
    routed
      ? { id: "tunnel-dns", label: "DNS route", status: "ok", detail: `${host} → ${name}` }
      : { id: "tunnel-dns", label: "DNS route", status: tunnel ? "fail" : "warn", detail: `${host} does not point at the tunnel`, remedy },
  );

  const registered = await supervisor().registered(tunnelLabel(config.serviceName));
  results.push(
    registered
      ? { id: "tunnel-service", label: "Tunnel service", status: "ok", detail: tunnelLabel(config.serviceName) }
      : { id: "tunnel-service", label: "Tunnel service", status: tunnel ? "fail" : "warn", remedy },
  );

  try {
    const response = await fetch(`${config.publicUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    results.push(
      response.ok
        ? { id: "public-url", label: "Public URL", status: "ok", detail: config.publicUrl }
        : { id: "public-url", label: "Public URL", status: "fail", detail: `health returned ${response.status}`, remedy },
    );
  } catch (error) {
    results.push({
      id: "public-url",
      label: "Public URL",
      status: registered ? "fail" : "warn",
      detail: error instanceof Error ? error.message : String(error),
      remedy,
    });
  }
  return results;
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
