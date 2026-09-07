import { spawn } from "node:child_process";

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/** Runs a command to completion, merging stdout/stderr in arrival order so
    logs read the way a terminal would. Never throws for non-zero exits. */
export async function run(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.on("error", (error) => resolve({ ok: false, exitCode: null, output: error.message }));
    child.on("close", (exitCode) => resolve({ ok: exitCode === 0, exitCode, output: output.trim() }));
  });
}

export class CommandError extends Error {
  constructor(executable: string, args: string[], result: RunResult) {
    const status = result.exitCode === null ? "could not run" : `exited ${result.exitCode}`;
    super(`${executable} ${args.join(" ")}: ${status}${result.output ? `\n${result.output}` : ""}`);
  }
}

export async function runOrThrow(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const result = await run(executable, args, options);
  if (!result.ok) throw new CommandError(executable, args, result);
  return result.output;
}
