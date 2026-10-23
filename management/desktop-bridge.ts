import { createInterface } from "node:readline";
import os from "node:os";
import { z } from "zod";
import { readConfigDocument } from "../lib/config-file.ts";
import { desktopOperation } from "./desktop-operations.ts";

const file = process.argv[2];
const machineId = process.argv[3];
if (!file || !machineId) throw new Error("Desktop bridge requires configuration and expected machine identity");
process.env.REMOTE_AGENT_CONFIG = file;
process.env.PATH = `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`;
const lines = createInterface({ input: process.stdin });
// stdout is the protocol. Diagnostics from helpers must never corrupt it.
console.log = (...args) => console.error(...args);
lines.on("line", async (line) => {
  let requestId: string | undefined;
  try {
    if (line.length > 2_000_000) throw new Error("Desktop request too large");
    const request = z.object({ id: z.string().max(100), method: z.string(), args: z.array(z.unknown()) }).strict().parse(JSON.parse(line));
    requestId = request.id;
    const document = readConfigDocument(file);
    if (!document.valid) throw new Error("Host configuration is invalid. Repair it on the selected machine.");
    if (document.value.machine.id !== machineId) throw new Error("SSH destination has a different machine identity; check this connection");
    const result = await desktopOperation(file, { method: request.method, args: request.args }, process.argv[4] || undefined);
    process.stdout.write(JSON.stringify({ id: requestId, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: requestId, error: error instanceof Error ? error.message : "Host operation failed" }) + "\n");
  }
});
lines.on("close", () => process.exit(0));
