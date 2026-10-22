import type { ServiceFile } from "./config.ts";
import type { DesktopHost } from "./desktop-host.ts";

export interface MachineNavigationSource {
  host: DesktopHost;
  config: ServiceFile | null;
  dirty: boolean;
  unavailable: boolean;
}

export interface MachineSidebarItem {
  key: string;
  kind: "provider" | "connection" | "machine" | "repository";
  id: string;
  hostId: string;
  hostName: string;
  label: string;
  dirty: boolean;
  unavailable: boolean;
}

/** Host-local IDs are never global identities, even when the labels match. */
export function machineSidebarItems(sources: MachineNavigationSource[]): MachineSidebarItem[] {
  const items: MachineSidebarItem[] = [];
  for (const kind of ["provider", "connection", "machine", "repository"] as const) {
    for (const { host, config, dirty, unavailable } of sources) {
      const entries: Array<[string, string]> = kind === "machine" ? [[host.id, host.name]]
        : kind === "provider" ? Object.keys(config?.providers ?? {}).map((id) => [id, id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : id])
        : kind === "connection" ? Object.entries(config?.connections ?? {}).map(([id, value]) => [id, value.name])
        : Object.entries(config?.repositories ?? {}).map(([id, value]) => [id, value.name ?? id]);
      for (const [id, label] of entries) items.push({
        key: JSON.stringify([host.id, kind, id]), kind, id, label,
        hostId: host.id, hostName: host.name, dirty, unavailable,
      });
    }
  }
  return items;
}
