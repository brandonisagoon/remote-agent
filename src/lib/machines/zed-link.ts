import type { MachineRecord } from "./registry.ts";

export function buildZedDeepLink(
  machine: MachineRecord,
  zedRemoteHost: string,
  worktreePath: string,
): string {
  return machine.zedConnection === "ssh"
    ? `zed://ssh/${encodeURIComponent(zedRemoteHost)}${encodeURI(worktreePath)}`
    : `zed://file${encodeURI(worktreePath)}`;
}
