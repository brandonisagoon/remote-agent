import { queryOptions } from "@tanstack/react-query";

export function sessionsQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: ["sessions", repositoryId],
    queryFn: () => window.remoteAgent.sessions.list(repositoryId),
    staleTime: 15_000,
  });
}
