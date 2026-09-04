import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, runOrThrow } from "../run.ts";
import type { ServiceDefinition, Supervisor } from "./types.ts";

/** A Task Scheduler logon task, not a Windows Service: Services run in
    session 0 without the user profile, and acpx provider processes need the
    user's credentials — the same reason macOS uses a launchd *user* agent.
    Restart-on-failure comes from the task settings XML. */

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function quoteArgument(argument: string): string {
  return /[\s"]/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

function renderTaskXml(definition: ServiceDefinition): string {
  const [executable, ...args] = definition.command;
  // Task Scheduler has no per-task environment or log redirection; wrap in
  // cmd so both work.
  const assignments = Object.entries(definition.environment)
    .map(([key, value]) => `set ${key}=${value}&& `)
    .join("");
  const commandLine = `${assignments}${quoteArgument(executable!)} ${args.map(quoteArgument).join(" ")} >> ${quoteArgument(definition.logFile)} 2>&1`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions>
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${escapeXml(`/c ${commandLine}`)}</Arguments>
      <WorkingDirectory>${escapeXml(definition.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export const windowsSupervisor: Supervisor = {
  async install(definition) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "remote-agent-task-"));
    const file = path.join(directory, "task.xml");
    try {
      writeFileSync(file, renderTaskXml(definition));
      await runOrThrow("schtasks", ["/Create", "/TN", definition.label, "/XML", file, "/F"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    await runOrThrow("schtasks", ["/Run", "/TN", definition.label]);
  },

  async uninstall(label) {
    await run("schtasks", ["/End", "/TN", label]);
    await run("schtasks", ["/Delete", "/TN", label, "/F"]);
  },

  async stop(label) {
    await run("schtasks", ["/End", "/TN", label]);
  },

  async registered(label) {
    return (await run("schtasks", ["/Query", "/TN", label])).ok;
  },

  async restart(definition) {
    await run("schtasks", ["/End", "/TN", definition.label]);
    const started = await run("schtasks", ["/Run", "/TN", definition.label]);
    // The task may have been stopped and deleted out of band; re-register.
    if (!started.ok) await windowsSupervisor.install(definition);
  },
};
