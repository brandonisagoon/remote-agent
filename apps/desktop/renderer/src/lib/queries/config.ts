import { queryOptions } from "@tanstack/react-query";
import { queryClient } from "@renderer/lib/queries/query-client.ts";

export function configQueryOptions(hostId: string) {
  return queryOptions({
    queryKey: ["config", hostId],
    queryFn: () => window.remoteAgent.forHost(hostId).config.get(),
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  });
}

export async function wireConfigStream(): Promise<void> {
  const { hosts } = await window.remoteAgent.hosts.list();
  for (const host of hosts) window.remoteAgent.forHost(host.id).config.onChange((document) => {
    queryClient.setQueryData(configQueryOptions(host.id).queryKey, document);
  });
}
