import { existsSync } from "node:fs";

import type { ServerConfig } from "../../config.ts";
import { DeployScriptMissingError } from "./errors.ts";

export interface TriggerDeployInput {
  ref: string;
  commit: string | undefined;
}

export function triggerDeploy(
  config: ServerConfig,
  input: TriggerDeployInput,
): void {
  if (!existsSync(config.deployScript)) {
    throw new DeployScriptMissingError(config.deployScript);
  }

  // Kick the POLLER's launchd job rather than spawning deploy.sh ourselves.
  //
  // A spawned child belongs to this service's launchd job, so when the deploy
  // stopped the service to run migrations it killed its own script mid-run —
  // leaving the service unloaded, unmigrated and down. unref() does not help;
  // launchd terminates the job, not just the parent process.
  //
  // The poller job is independent, so a deploy it runs survives this service
  // being stopped and restarted. deploy.sh's lock still prevents overlap.
  const child = Bun.spawn(
    [
      "launchctl",
      "kickstart",
      `gui/${process.getuid?.() ?? ""}/${config.deployJobLabel}`,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();

  console.log(
    `[deploy] triggered by push ${input.commit ?? "?"} to ${input.ref}`,
  );
}
