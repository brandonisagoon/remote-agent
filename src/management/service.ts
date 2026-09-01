import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { configFilePath, readConfig } from "../lib/config.ts";

export interface ManagementResult {
  ok: boolean;
  summary: string;
  detail?: string;
}

function sourceRoot(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && existsSync(path.join(resourcesPath, "scripts", "install.sh"))) {
    return resourcesPath;
  }
  return path.resolve(import.meta.dir, "..", "..");
}

function updateCheckout(): string {
  const source = sourceRoot();
  if (existsSync(path.join(source, ".git"))) return source;
  return path.join(readConfig().installRoot, "repo");
}

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<ManagementResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => resolve({ ok: false, summary: `Could not run ${executable}`, detail: error.message }));
    child.on("close", (exitCode) => {
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      resolve({
        ok: exitCode === 0,
        summary: exitCode === 0 ? "Command completed" : `Command exited ${exitCode ?? "without a status"}`,
        ...(detail ? { detail } : {}),
      });
    });
  });
}

export async function serviceStatus(): Promise<ManagementResult> {
  try {
    const config = readConfig();
    const response = await fetch(
      `http://${config.hostname}:${config.port}/health`,
      { signal: AbortSignal.timeout(2_000) },
    );
    return {
      ok: response.ok,
      summary: response.ok ? "Daemon is running" : `Daemon returned ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      summary: "Daemon is unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function doctor(): Promise<ManagementResult> {
  try {
    const config = readConfig();
    const missing = Object.values(config.repositories)
      .filter((repository) => !existsSync(repository.root))
      .map((repository) => `${repository.id}: ${repository.root}`);
    const status = await serviceStatus();
    const lines = [
      `Config: ${config.configFile}`,
      `Machine: ${config.machine}`,
      `Repositories: ${Object.keys(config.repositories).length}`,
      `Daemon: ${status.ok ? "running" : "unavailable"}`,
      ...(missing.length ? ["Missing repository roots:", ...missing] : []),
    ];
    return {
      ok: missing.length === 0 && status.ok,
      summary: missing.length === 0 ? "Configuration is valid" : "Configuration needs attention",
      detail: lines.join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      summary: "Configuration is invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installService(): Promise<ManagementResult> {
  const root = sourceRoot();
  return command("bash", [path.join(root, "scripts", "install.sh")], {
    cwd: root,
    env: { REMOTE_AGENT_CONFIG: configFilePath() },
  });
}

export async function checkForUpdates(): Promise<ManagementResult> {
  const config = readConfig();
  const root = updateCheckout();
  if (!existsSync(path.join(root, ".git"))) {
    return { ok: false, summary: "Service is not installed", detail: `No deployment checkout at ${root}` };
  }
  const result = await command("git", ["fetch", "--quiet", "origin", config.deployBranch], { cwd: root });
  if (!result.ok) return { ...result, summary: "Update check failed" };
  const comparison = await command(
    "git",
    ["rev-list", "--count", `HEAD..origin/${config.deployBranch}`],
    { cwd: root },
  );
  if (!comparison.ok) return { ...comparison, summary: "Update comparison failed" };
  const count = Number(comparison.detail ?? "0");
  return {
    ok: true,
    summary: count > 0 ? `${count} update${count === 1 ? "" : "s"} available` : "Up to date",
    detail: String(count),
  };
}

export async function installUpdate(): Promise<ManagementResult> {
  const config = readConfig();
  return command("bash", [config.deployScript, "--force"], {
    env: { REMOTE_AGENT_CONFIG: config.configFile },
  });
}

export async function restartService(): Promise<ManagementResult> {
  const config = readConfig();
  return command("launchctl", [
    "kickstart",
    "-k",
    `gui/${process.getuid?.() ?? 0}/dev.${config.serviceName}.service`,
  ]);
}
