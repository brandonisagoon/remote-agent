import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { configFilePath, readConfig } from "../lib/config.ts";
import { findExecutable, installLayout, sourceRoot } from "./paths.ts";
import { run, runOrThrow } from "./run.ts";
import { daemonDefinition, supervisor } from "./supervisor/index.ts";
import { syncTree } from "./sync-tree.ts";

/** One-time provisioning (TS port of the retired install.sh). Idempotent:
    safe to re-run after an upgrade or a failed attempt.

    Provisioning is deliberately separate from startup. Creating a tunnel or
    a DNS record mints long-lived credentials against a real domain, so this
    never does either — the running service only ever does
    `cloudflared tunnel run`. */
export async function provision(log: (line: string) => void): Promise<void> {
  const configFile = configFilePath();
  const config = readConfig();
  const layout = installLayout(config.installRoot);
  // The Electron main process (Node, not Bun) also calls this — stay
  // runtime-neutral.
  const file = JSON.parse(readFileSync(configFile, "utf8")) as {
    machine?: { installation?: { gitRemote?: string; branch?: string } };
  };
  const branch = file.machine?.installation?.branch ?? "main";
  const bun = findExecutable("bun");
  if (!bun) throw new Error("bun was not found on PATH or in known install locations");

  log("==> Directories");
  mkdirSync(layout.root, { recursive: true });
  mkdirSync(layout.state, { recursive: true });
  if (process.platform !== "win32") chmodSync(layout.state, 0o700);
  log(`  ${layout.root}`);

  log("==> Repository");
  // Inherit the remote URL from the checkout this runs from, so the deploy
  // clone authenticates the same way the working checkout already does.
  const gitRemote =
    file.machine?.installation?.gitRemote ??
    (await run("git", ["-C", sourceRoot(), "remote", "get-url", "origin"])).output.trim();
  if (!existsSync(path.join(layout.repo, ".git"))) {
    if (!gitRemote) throw new Error("machine.installation.gitRemote is required when the source checkout has no origin");
    await runOrThrow("git", ["clone", "--quiet", "--depth=1", "--branch", branch, gitRemote, layout.repo]);
    log(`  cloned ${gitRemote}`);
  } else {
    await runOrThrow("git", ["-C", layout.repo, "fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    // A dedicated deployment clone: selecting another configured branch must
    // update the worktree too, or an old Prisma client can pair with a newer
    // database.
    await runOrThrow("git", ["-C", layout.repo, "reset", "--hard", "--quiet", `origin/${branch}`]);
    log("  already present, refreshed");
  }

  log("==> Configuration");
  if (process.platform !== "win32") chmodSync(configFile, 0o600);
  writeFileSync(path.join(layout.state, "service-name"), `${config.serviceName}\n`);
  log(`  using canonical configuration at ${configFile}`);

  log("==> First build");
  syncTree(layout.repo, layout.app);
  const env = { REMOTE_AGENT_CONFIG: configFile };
  await runOrThrow(bun, ["install", "--silent"], { cwd: layout.app, env });
  await runOrThrow(bun, ["x", "prisma", "generate"], { cwd: layout.app, env });
  await runOrThrow(bun, ["x", "prisma", "migrate", "deploy"], { cwd: layout.app, env });
  if (process.platform !== "win32") {
    for (const entry of readdirSync(layout.state)) {
      if (entry.endsWith(".sqlite")) chmodSync(path.join(layout.state, entry), 0o600);
    }
  }
  log("  built");

  log("==> Service");
  await supervisor().install(daemonDefinition({
    serviceName: config.serviceName,
    appRoot: layout.app,
    configFile,
    logFile: layout.serviceLog,
  }));
  log(`  registered dev.${config.serviceName}.service`);

  log("==> Verify");
  const health = `http://127.0.0.1:${config.port}/health`;
  if (await waitForHealth(health, 30)) log("  local health OK");
  else log(`  local health FAILED — check ${layout.serviceLog}`);
  const publicHealth = `${config.publicUrl.replace(/\/$/, "")}/health`;
  if (await healthy(publicHealth)) log(`  public health OK  (${config.publicUrl})`);
  else log("  public health FAILED — check the machine's Cloudflare tunnel");
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(url: string, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await healthy(url)) return true;
  }
  return false;
}
