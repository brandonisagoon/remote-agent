import { queryOptions } from "@tanstack/react-query";

/** Each machine owns its management checklist and refresh state. */
export function checksQueryOptions(hostId: string) {
  return queryOptions({
    queryKey: ["management-checks", hostId],
    queryFn: () => window.remoteAgent.forHost(hostId).management.checks(),
    staleTime: 10_000,
  });
}
