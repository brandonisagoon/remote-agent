import type { MachineRecord } from "./registry.ts";

export function buildZedDeepLink(
  machine: MachineRecord,
  zedRemoteHost: string | null,
  worktreePath: string,
): string {
  if (machine.zedConnection === "local") {
    return `zed://file${encodeURI(worktreePath)}`;
  }
  if (!zedRemoteHost) {
    throw new Error("zedRemoteHost is required for an SSH machine");
  }
  return `zed://ssh/${encodeURIComponent(zedRemoteHost)}${encodeURI(worktreePath)}`;
}
