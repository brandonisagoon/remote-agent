import { useParams } from "@tanstack/react-router";
import type { useNavigate } from "@tanstack/react-router";
import { useHost, useHostDirectory } from "./host-context.tsx";
import { machineSidebarItems } from "../../../../../lib/desktop-navigation.ts";

export const PROVIDER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code" };
export type SidebarItem = ReturnType<typeof machineSidebarItems>[number];

/** Pointer and keyboard navigation share the same complete machine directory. */
export function useSidebarItems(): SidebarItem[] {
  const { entries } = useHostDirectory();
  return machineSidebarItems(entries.map(({ host, config, error }) => ({
    host, config: config.draft, dirty: config.anyDirty, unavailable: !!error,
  })));
}

export function useCurrentSidebarIndex(items: SidebarItem[]): number {
  const params = useParams({ strict: false });
  const { host } = useHost();
  const kind = params.providerId ? "provider" : params.connectionId ? "connection" : params.repositoryId ? "repository" : "machine";
  const id = params.providerId ?? params.connectionId ?? params.repositoryId ?? host.id;
  return items.findIndex((item) => item.kind === kind && item.hostId === host.id && item.id === id);
}

export function navigateToItem(navigate: ReturnType<typeof useNavigate>, item: SidebarItem): void {
  const search = { host: item.hostId };
  if (item.kind === "machine") void navigate({ to: "/machine", search });
  else if (item.kind === "provider") void navigate({ to: "/providers/$providerId", params: { providerId: item.id }, search });
  else if (item.kind === "connection") void navigate({ to: "/connections/$connectionId", params: { connectionId: item.id }, search });
  else void navigate({ to: "/repositories/$repositoryId", params: { repositoryId: item.id }, search });
}
