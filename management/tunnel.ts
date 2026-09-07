import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readConfig, readServiceFile, type ServerConfig } from "../lib/config.ts";
import { findExecutable } from "./paths.ts";
import { installLayout } from "./paths.ts";
import { run, runInteractive, runOrThrow } from "./run.ts";
import { serviceLabel, supervisor, type ServiceDefinition } from "./supervisor/index.ts";
import { waitForHealth } from "./provision.ts";

/** The tunnel is named after the service unless the config overrides it. */
export function tunnelName(config: Pick<ServerConfig, "serviceName">): string {
  try {
    const file = readServiceFile();
    return file.machine.installation.tunnelName ?? config.serviceName;
  } catch {
    return config.serviceName;
  }
}

/** The hostname Linear delivers to — the host of the configured publicUrl. */
export function tunnelHost(config: Pick<ServerConfig, "publicUrl">): string {
  return new URL(config.publicUrl).host;
}

export function tunnelLabel(serviceName: string): string {
  return `${serviceLabel(serviceName)}.tunnel`;
}

/** cloudflared writes its account certificate here after `tunnel login`. */
export function tunnelLoginCert(): string {
  return process.env.TUNNEL_ORIGIN_CERT ?? path.join(os.homedir(), ".cloudflared", "cert.pem");
}

/** The tunnel runner as a supervised service beside the server: no
    config.yml to author — `--url` is the ingress. */
export function tunnelDefinition(input: {
  serviceName: string;
  cloudflared: string;
  name: string;
  port: number;
  logFile: string;
}): ServiceDefinition {
  return {
    label: tunnelLabel(input.serviceName),
    command: [
      input.cloudflared,
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${input.port}`,
      "run",
      input.name,
    ],
    workingDirectory: os.homedir(),
    environment: {
      ...(process.platform === "win32" ? {} : { HOME: process.env.HOME ?? os.homedir() }),
      PATH: process.env.PATH ?? "",
    },
    logFile: input.logFile,
  };
}

export async function listTunnels(cloudflared: string): Promise<Array<{ id: string; name: string }> | null> {
  const result = await run(cloudflared, ["tunnel", "list", "--output", "json"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.output) as Array<{ id: string; name: string }>;
  } catch {
    return null;
  }
}

/** One idempotent walk through every tunnel step. Login is the only
    interactive part (a browser handshake); everything after it is
    non-interactive account writes and a supervisor registration. */
export async function setupTunnel(log: (line: string) => void = console.log): Promise<void> {
  const config = readConfig();
  const cloudflared = findExecutable("cloudflared");
  if (!cloudflared) throw new Error("cloudflared is not installed (brew install cloudflared)");
  const name = tunnelName(config);
  const host = tunnelHost(config);

  log("==> Login");
  if (existsSync(tunnelLoginCert())) {
    log(`  already logged in (${tunnelLoginCert()})`);
  } else {
    log("  opening the browser for cloudflared tunnel login");
    await runInteractive(cloudflared, ["tunnel", "login"]);
    if (!existsSync(tunnelLoginCert())) throw new Error("login did not produce a certificate");
  }

  log("==> Tunnel");
  const tunnels = await listTunnels(cloudflared);
  if (!tunnels) throw new Error("could not list tunnels; is the login still valid?");
  if (tunnels.some((tunnel) => tunnel.name === name)) {
    log(`  exists: ${name}`);
  } else {
    await runOrThrow(cloudflared, ["tunnel", "create", name]);
    log(`  created: ${name}`);
  }

  log("==> DNS");
  const route = await run(cloudflared, ["tunnel", "route", "dns", name, host]);
  if (route.ok || /already exists|already configured/i.test(route.output)) {
    log(`  ${host} → ${name}`);
  } else {
    throw new Error(`could not route ${host}: ${route.output}`);
  }

  log("==> Service");
  const layout = installLayout(config.installRoot);
  await supervisor().install(
    tunnelDefinition({
      serviceName: config.serviceName,
      cloudflared,
      name,
      port: config.port,
      logFile: path.join(layout.state, "tunnel.log"),
    }),
  );
  log(`  ${tunnelLabel(config.serviceName)} running`);

  log("==> Verify");
  const healthy = await waitForHealth(`${config.publicUrl.replace(/\/$/, "")}/health`, 30);
  if (!healthy) {
    throw new Error(`${config.publicUrl} did not answer through the tunnel; DNS may still be propagating`);
  }
  log(`  ${config.publicUrl} reachable`);
}
