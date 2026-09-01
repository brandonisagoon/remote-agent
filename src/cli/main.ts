#!/usr/bin/env bun

import { Command } from "commander";

import {
  checkForUpdates,
  doctor,
  installService,
  installUpdate,
  restartService,
  serviceStatus,
} from "../management/service.ts";

function action(run: () => Promise<{ ok: boolean; summary: string; detail?: string }>) {
  return async () => {
    const result = await run();
    console.log(result.summary);
    if (result.detail) console.log(result.detail);
    if (!result.ok) process.exitCode = 1;
  };
}

const program = new Command()
  .name("remote-agent")
  .description("Install and manage the local Remote Agent service")
  .version("0.1.0");

program.command("install").description("Install the local daemon").action(action(installService));
program.command("status").description("Show local daemon status").action(action(serviceStatus));
program.command("doctor").description("Validate config and local dependencies").action(action(doctor));
program.command("check-update").description("Check the configured release branch").action(action(checkForUpdates));
program.command("update").description("Install the latest configured release").action(action(installUpdate));
program.command("restart").description("Restart the local daemon").action(action(restartService));

await program.parseAsync();
