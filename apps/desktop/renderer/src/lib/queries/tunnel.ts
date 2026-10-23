import { queryOptions } from "@tanstack/react-query";

export function tunnelInfoQueryOptions(hostId: string, name: string) {
  return queryOptions({
    queryKey: ["tunnel-info", hostId, name],
    queryFn: () => window.remoteAgent.forHost(hostId).tunnel.info(name),
    staleTime: 60_000,
  });
}
