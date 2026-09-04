import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, runOrThrow } from "../run.ts";
import type { ServiceDefinition, Supervisor } from "./types.ts";

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function plistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPlist(definition: ServiceDefinition): string {
  const args = definition.command
    .map((argument) => `\t\t<string>${escapeXml(argument)}</string>`)
    .join("\n");
  const env = Object.entries(definition.environment)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key><string>${escapeXml(definition.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WorkingDirectory</key><string>${escapeXml(definition.workingDirectory)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key><true/>
\t<key>KeepAlive</key><true/>
\t<key>ThrottleInterval</key><integer>10</integer>
\t<key>StandardOutPath</key><string>${escapeXml(definition.logFile)}</string>
\t<key>StandardErrorPath</key><string>${escapeXml(definition.logFile)}</string>
</dict>
</plist>
`;
}

function writePlist(definition: ServiceDefinition): string {
  const file = plistPath(definition.label);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderPlist(definition));
  return file;
}

export const launchdSupervisor: Supervisor = {
  async install(definition) {
    const file = writePlist(definition);
    await run("launchctl", ["bootout", `${domain()}/${definition.label}`]);
    await runOrThrow("launchctl", ["bootstrap", domain(), file]);
  },

  async uninstall(label) {
    await run("launchctl", ["bootout", `${domain()}/${label}`]);
    rmSync(plistPath(label), { force: true });
  },

  async stop(label) {
    // bootout both stops and unloads; the plist stays, so the daemon still
    // starts at next login. restart() re-bootstraps it.
    await run("launchctl", ["bootout", `${domain()}/${label}`]);
  },

  async registered(label) {
    return existsSync(plistPath(label));
  },

  async restart(definition) {
    const file = writePlist(definition);
    // The service may be unloaded (stop() during a deploy migration), so
    // bootstrap it back rather than assuming kickstart can find it.
    await run("launchctl", ["bootstrap", domain(), file]);
    await run("launchctl", ["kickstart", "-k", `${domain()}/${definition.label}`]);
  },
};
