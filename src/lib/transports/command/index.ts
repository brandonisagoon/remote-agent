import type { CommandClient } from "../../../types/runtime/index.ts";

export const COMMAND_TIMEOUT_MS = 10_000;

export const bunCommandClient: CommandClient = {
  async run(command, args, options = {}) {
    if (options.detached) {
      const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        stdin: options.stdin
          ? new TextEncoder().encode(options.stdin)
          : "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
      return { ok: true, stdout: "", stderr: "" };
    }

    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdin: options.stdin
        ? new TextEncoder().encode(options.stdin)
        : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(9), COMMAND_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { ok: exitCode === 0, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  },
};
