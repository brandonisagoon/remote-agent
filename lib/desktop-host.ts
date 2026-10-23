import { z } from "zod";

const absolute = z.string().min(1).refine((value) => value.startsWith("/") && !/[\r\n\0]/.test(value), "Use an absolute path");
export const DesktopHostSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().min(1), name: z.string().min(1), kind: z.literal("local"), configPath: absolute.optional() }).strict(),
  z.object({
    id: z.string().min(1), name: z.string().min(1), kind: z.literal("ssh"),
    sshHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/),
    configPath: absolute, runtimePath: absolute, executable: absolute,
    machineId: z.string().min(1), serviceLabel: z.string().regex(/^[a-zA-Z0-9.-]+$/).optional(),
  }).strict(),
]);
export type DesktopHost = z.infer<typeof DesktopHostSchema>;
export type SshDesktopHost = Extract<DesktopHost, { kind: "ssh" }>;
export const DesktopHostsSchema = z.object({ activeId: z.string(), hosts: z.array(DesktopHostSchema).min(1) }).superRefine((value, context) => {
  if (new Set(value.hosts.map((host) => host.id)).size !== value.hosts.length || !value.hosts.some((host) => host.id === value.activeId)) context.addIssue({ code: "custom", message: "Choose a configured, uniquely named machine" });
});
export type DesktopHosts = z.infer<typeof DesktopHostsSchema>;
export const STORED_SECRET = "__REMOTE_AGENT_STORED_SECRET__";
const secretKeys = new Set(["secret", "clientSecret", "apiKey"]);

/** Markers are resolved against the same path in a revision-checked document.
 * A marker cannot copy a credential into a different connection or field. */
export function concealHostSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string" && secretKeys.has(key)) return STORED_SECRET;
  if (Array.isArray(value)) return value.map((entry) => concealHostSecrets(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, concealHostSecrets(entry, name)]));
  return value;
}

export function restoreHostSecrets(value: unknown, current: unknown, key = ""): unknown {
  if (value === STORED_SECRET) {
    if (!secretKeys.has(key) || typeof current !== "string") throw new Error("Stored credential no longer exists at this field; enter a replacement");
    return current;
  }
  if (Array.isArray(value)) return value.map((entry, index) => restoreHostSecrets(entry, Array.isArray(current) ? current[index] : undefined));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, restoreHostSecrets(entry, current && typeof current === "object" ? (current as Record<string, unknown>)[name] : undefined, name)]));
  return value;
}

export interface DesktopHostStatus { connected: boolean; serverAvailable: boolean; machineId?: string; detail?: string }
export interface DesktopTask {
  id: string; repositoryId: string; machineId: string; issueIdentifier: string | null;
  branchName: string; primarySessionId: string | null; phase: string; environmentStatus: string;
  worktreePath: string | null; controlMode: string; controllerId: string | null; recoveryDetail: string | null; updatedAt: string;
  resources: Array<{ id: string; key: string; kind: string; purpose: string; externalId: string; state: string }>;
}
export interface DesktopTaskActivity {
  task: DesktopTask;
  session: { id: string; status: string } | null;
  history: unknown[];
  questions: Array<{ id: string; body: string; state: string; error: string | null }>;
  instructions: Array<{ id: string; text: string; state: string; detail: string | null }>;
}
