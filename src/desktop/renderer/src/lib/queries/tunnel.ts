import { queryOptions } from "@tanstack/react-query";

export function tunnelInfoQueryOptions(name: string) {
  return queryOptions({
    queryKey: ["tunnel-info", name],
    queryFn: () => window.remoteAgent.tunnel.info(name),
    staleTime: 60_000,
  });
}
