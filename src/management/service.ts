import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { configFilePath, readConfig } from "../lib/config.ts";
import { findExecutable, installLayout, sourceRoot } from "./paths.ts";
import { runChecks } from "./checks.ts";
import { provision } from "./provision.ts";
import { daemonDefinition, supervisor } from "./supervisor/index.ts";

export interface ManagementResult {
  ok: boolean;
  summary: string;
  detail?: string;
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
  const checks = await runChecks();
  const failed = checks.filter((check) => check.status === "fail");
  const marks: Record<string, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const lines = checks.map((check) => {
    const parts = [`${marks[check.status]}  ${check.label}`];
    if (check.detail) parts.push(`      ${check.detail.replaceAll("\n", "\n      ")}`);
    if (check.status !== "ok" && check.remedy) parts.push(`      → ${check.remedy}`);
    return parts.join("\n");
  });
  return {
    ok: failed.length === 0,
    summary: failed.length === 0
      ? "All checks passed"
      : `${failed.length} check${failed.length === 1 ? "" : "s"} failing`,
    detail: lines.join("\n"),
  };
}

export async function installService(): Promise<ManagementResult> {
  const lines: string[] = [];
  try {
    await provision((line) => lines.push(line));
    return { ok: true, summary: "Service installed", detail: lines.join("\n") };
  } catch (error) {
    lines.push(error instanceof Error ? error.message : String(error));
    return { ok: false, summary: "Install failed", detail: lines.join("\n") };
  }
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
  const bun = findExecutable("bun");
  if (!bun) return { ok: false, summary: "bun was not found on PATH" };
  const script = existsSync(config.deployScript)
    ? config.deployScript
    : path.join(sourceRoot(), "src", "management", "deploy.ts");
  const result = await command(bun, [script, "--force"], {
    env: { REMOTE_AGENT_CONFIG: config.configFile },
  });
  const deployLog = installLayout(config.installRoot).deployLog;
  return result.ok
    ? { ...result, summary: "Update complete" }
    : { ...result, summary: `Update failed — see ${deployLog}` };
}

const CLI_LINK = "/usr/local/bin/remote-agent";

/** The wrapper script the /usr/local/bin symlink should point at — the
    deployment copy when the service is installed (deploy keeps it
    current), this checkout otherwise. */
export function cliEntryPath(): string {
  let appRoot = sourceRoot();
  try {
    const deployed = path.join(readConfig().installRoot, "app");
    if (existsSync(path.join(deployed, "bin", "remote-agent"))) appRoot = deployed;
  } catch {
    // Unreadable config: the checkout fallback still works.
  }
  return path.join(appRoot, "bin", "remote-agent");
}

export function cliInstalled(): boolean {
  return existsSync(CLI_LINK);
}

/** Opens the user's terminal with a command prefilled, so privileged or
    account-bound steps (sudo, brew, cloudflared login) run in their own
    shell — never from the app. */
export async function openInTerminal(commandLine: string): Promise<ManagementResult> {
  if (process.platform === "win32") {
    const result = await command("cmd.exe", ["/c", "start", "cmd.exe", "/k", commandLine]);
    return result.ok
      ? { ok: true, summary: "Continue in the terminal — the command is ready to run", detail: commandLine }
      : { ...result, summary: "Could not open a terminal" };
  }
  const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(commandLine)}\nend tell`;
  const result = await command("osascript", ["-e", script]);
  return result.ok
    ? { ok: true, summary: "Continue in Terminal — the command is ready to run", detail: commandLine }
    : { ...result, summary: "Could not open Terminal" };
}

/** Deliberately dumb: opens Terminal with the symlink command prefilled so
    sudo runs in the user's own shell, instead of doing privileged writes
    from the app. */
export async function installCli(): Promise<ManagementResult> {
  const entry = cliEntryPath();
  if (!existsSync(entry)) {
    return { ok: false, summary: "CLI source not found", detail: entry };
  }
  return openInTerminal(`sudo ln -sf '${entry}' ${CLI_LINK}`);
}

/** Unregisters the daemon. Leaves state/ (database, keys, logs) and the
    cloudflared daemon alone — losing session registrations to a reinstall
    would be surprising, and the tunnel is shared infrastructure. `purge`
    additionally deletes the whole install root, including the database. */
export async function uninstallService(options: { purge?: boolean } = {}): Promise<ManagementResult> {
  try {
    const config = readConfig();
    await supervisor().uninstall(`dev.${config.serviceName}.service`);
    if (options.purge) {
      const { rmSync } = await import("node:fs");
      rmSync(config.installRoot, { recursive: true, force: true });
      return { ok: true, summary: "Service removed and install root purged" };
    }
    return { ok: true, summary: "Service removed (state kept)" };
  } catch (error) {
    return {
      ok: false,
      summary: "Uninstall failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function restartService(): Promise<ManagementResult> {
  try {
    const config = readConfig();
    const layout = installLayout(config.installRoot);
    await supervisor().restart(daemonDefinition({
      serviceName: config.serviceName,
      appRoot: layout.app,
      configFile: configFilePath(),
      logFile: layout.serviceLog,
    }));
    return { ok: true, summary: "Service restarted" };
  } catch (error) {
    return {
      ok: false,
      summary: "Restart failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
