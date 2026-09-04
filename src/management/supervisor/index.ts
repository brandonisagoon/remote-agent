import os from "node:os";
import path from "node:path";

import { findExecutable } from "../paths.ts";
import { launchdSupervisor } from "./launchd.ts";
import type { ServiceDefinition, Supervisor } from "./types.ts";
import { windowsSupervisor } from "./windows.ts";

export type { ServiceDefinition, Supervisor } from "./types.ts";

export function supervisor(): Supervisor {
  return process.platform === "win32" ? windowsSupervisor : launchdSupervisor;
}

export function serviceLabel(serviceName: string): string {
  return `dev.${serviceName}.service`;
}

/** The daemon's registration: bun running server.ts out of the deployment
    copy, pointed at the canonical config file. */
export function daemonDefinition(input: {
  serviceName: string;
  appRoot: string;
  configFile: string;
  logFile: string;
}): ServiceDefinition {
  const bun = findExecutable("bun");
  if (!bun) throw new Error("bun was not found on PATH or in known install locations");
  return {
    label: serviceLabel(input.serviceName),
    command: [bun, path.join(input.appRoot, "src", "server.ts")],
    workingDirectory: input.appRoot,
    environment: {
      REMOTE_AGENT_CONFIG: input.configFile,
      ...(process.platform === "win32" ? {} : { HOME: process.env.HOME ?? os.homedir() }),
      // The daemon spawns provider CLIs; give it the package-manager dirs a
      // login shell would have, not just the supervisor's minimal PATH.
      PATH: [
        path.dirname(bun),
        ...(process.platform === "win32"
          ? []
          : ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
        process.env.PATH ?? "",
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
    logFile: input.logFile,
  };
}
