import path from "node:path";
import { z } from "zod";

const Absolute = z.string().min(1).refine(value => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"));
export const ConnectorProcess = z.object({
  pid: z.number().int().positive().max(0x7fffffff), start: z.string().min(1),
  uid: z.number().int().nonnegative(), cwd: Absolute, executable: Absolute,
  argv: z.array(z.string()).min(1).max(8),
}).strict();
export const ConnectorMetadata = z.object({
  version: z.literal(1).optional(), pid: z.number().int().positive().max(0x7fffffff),
  process: ConnectorProcess.optional(), startedAt: z.iso.datetime().optional(),
  configPath: Absolute, pidFile: Absolute, tunnelId: z.uuid(),
  hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/),
  source: z.url(), dedicated: z.literal(true), shared: z.literal(false).optional(),
  taskId: z.string().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.process && value.process.pid !== value.pid) ctx.addIssue({ code: "custom", message: "Connector process PID differs from its receipt" });
  const url = new URL(value.source);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    ctx.addIssue({ code: "custom", message: "Connector source must be its exact loopback endpoint" });
  }
  if (path.dirname(value.pidFile) !== path.dirname(value.configPath)) ctx.addIssue({ code: "custom", message: "Connector PID and config files must share their recorded directory" });
  if (!value.process && !value.startedAt) ctx.addIssue({ code: "custom", message: "Connector has no recorded process start identity" });
});
export function validateConnectorReceipt(externalId: string, metadata: unknown, historical = false, owner?: { taskId: string; purpose: string }) {
  const value = ConnectorMetadata.parse(metadata);
  if (owner && (!["development", "review"].includes(owner.purpose) || value.taskId !== undefined && value.taskId !== owner.taskId)) throw new Error("Connector receipt belongs to another task or purpose");
  if (externalId !== `pid:${value.pid}`) throw new Error("Connector external identity differs from its recorded PID");
  if (!historical && (value.version !== 1 || !value.process)) throw new Error("New connectors require a versioned complete process identity");
  if (value.process) {
    const p = value.process, expected = [p.argv[0], "--config", value.configPath, "tunnel", "run"];
    if (path.basename(p.executable) !== "cloudflared" || !p.argv[0] || path.basename(p.argv[0]) !== "cloudflared"
      || p.argv.length !== 5 && p.argv.length !== 6 || expected.some((arg, index) => p.argv[index] !== arg)
      || p.argv.length === 6 && p.argv[5] !== value.tunnelId) throw new Error("Connector arguments do not identify the exact dedicated tunnel");
  }
  return value;
}
