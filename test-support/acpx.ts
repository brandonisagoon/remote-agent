import path from "node:path";

export const FAKE_ACPX = path.join(import.meta.dir, "fake-acpx.ts");

/** Points the router at a substitute acpx CLI for the duration of `run`. */
export async function withAcpxCli<T>(cli: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.REMOTE_AGENT_ACPX_CLI;
  process.env.REMOTE_AGENT_ACPX_CLI = cli;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.REMOTE_AGENT_ACPX_CLI;
    else process.env.REMOTE_AGENT_ACPX_CLI = previous;
  }
}
