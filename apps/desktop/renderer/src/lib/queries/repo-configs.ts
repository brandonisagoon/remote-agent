import { queryOptions } from "@tanstack/react-query";
import type { RepoConfigDocument } from "../../../../../../lib/config-file.ts";
import { queryClient } from "@renderer/lib/queries/query-client.ts";

export type RepoConfigDocuments = Record<string, RepoConfigDocument & { root: string }>;

export function repoConfigsQueryOptions(hostId: string) {
  return queryOptions({
    queryKey: ["repo-configs", hostId],
    queryFn: () => window.remoteAgent.forHost(hostId).repoConfigs.get(),
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  });
}

export async function wireRepoConfigsStream(): Promise<void> {
  const { hosts } = await window.remoteAgent.hosts.list();
  for (const host of hosts) window.remoteAgent.forHost(host.id).repoConfigs.onChange((documents) => {
    queryClient.setQueryData(repoConfigsQueryOptions(host.id).queryKey, documents);
  });
}
