import { useParams } from "@tanstack/react-router";
import type { useNavigate } from "@tanstack/react-router";

import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";

export const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

export interface SidebarItem {
  id: string;
  label: string;
  link:
    | { to: "/machine"; hostId: string }
    | { to: "/providers/$providerId"; params: { providerId: string } }
    | { to: "/connections/$connectionId"; params: { connectionId: string } }
    | { to: "/repositories/$repositoryId"; params: { repositoryId: string } };
}

/** Sidebar destinations in display order: providers, connections, machine, repositories. */
export function useSidebarItems(): SidebarItem[] {
  const { draft } = useConfig();
  const { hosts } = useHost();
  return [
    ...Object.keys(draft.providers).map((id) => ({
      id: `provider:${id}`,
      label: PROVIDER_LABELS[id] ?? id,
      link: { to: "/providers/$providerId" as const, params: { providerId: id } },
    })),
    ...Object.entries(draft.connections).map(([id, connection]) => ({
      id: `connection:${id}`,
      label: connection.name,
      link: { to: "/connections/$connectionId" as const, params: { connectionId: id } },
    })),
    ...hosts.hosts.map((host) => ({
      id: `machine:${host.id}`,
      label: hosts.hosts.length === 1 ? draft.machine.name : host.name,
      link: { to: "/machine" as const, hostId: host.id },
    })),
    ...Object.entries(draft.repositories).map(([id, repository]) => ({
      id: `repository:${id}`,
      label: repository.name ?? id,
      link: { to: "/repositories/$repositoryId" as const, params: { repositoryId: id } },
    })),
  ];
}

export function useCurrentSidebarIndex(items: SidebarItem[]): number {
  const params = useParams({ strict: false });
  const { host } = useHost();
  if (params.providerId) return items.findIndex((item) => item.id === `provider:${params.providerId}`);
  if (params.connectionId) return items.findIndex((item) => item.id === `connection:${params.connectionId}`);
  if (params.repositoryId) return items.findIndex((item) => item.id === `repository:${params.repositoryId}`);
  return items.findIndex((item) => item.id === `machine:${host.id}`);
}

export function navigateToItem(navigate: ReturnType<typeof useNavigate>, item: SidebarItem, host: ReturnType<typeof useHost>): void {
  if (item.link.to === "/machine") {
    if (item.link.hostId === host.host.id) void navigate({ to: "/machine" });
    else void host.select(item.link.hostId);
  } else if (item.link.to === "/providers/$providerId") {
    void navigate({ to: item.link.to, params: item.link.params });
  } else if (item.link.to === "/connections/$connectionId") {
    void navigate({ to: item.link.to, params: item.link.params });
  } else {
    void navigate({ to: item.link.to, params: item.link.params });
  }
}
