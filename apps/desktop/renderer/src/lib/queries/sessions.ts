import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { combineMachineSessions } from "../../../../../../lib/desktop-sessions.ts";
import { useHost } from "@renderer/lib/host-context.tsx";

export function repositorySessionsKey(repositoryId: string) {
  return ["sessions", repositoryId] as const;
}

function repositoryReferenceOptions(repositoryId: string, hostId: string) {
  return queryOptions({
    queryKey: [...repositorySessionsKey(repositoryId), "reference", hostId],
    queryFn: () => window.remoteAgent.sessions.repositoryReference(repositoryId),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useRepositorySessions(repositoryId: string) {
  const { host, hosts } = useHost();
  const reference = useQuery(repositoryReferenceOptions(repositoryId, host.id));
  const queries = useQueries({ queries: hosts.hosts.map((machine) => ({
    queryKey: [...repositorySessionsKey(repositoryId), "machine", machine.id, reference.data],
    queryFn: () => window.remoteAgent.sessions.forHost(machine.id, reference.data!),
    enabled: !!reference.data,
    staleTime: 3000,
    refetchInterval: 5000,
    retry: false,
  })) });
  const snapshots = queries.map((query, index) => ({
    hostId: hosts.hosts[index]!.id,
    machineName: hosts.hosts[index]!.name,
    data: query.data,
    unavailable: query.isError,
  }));
  return {
    sessions: combineMachineSessions(snapshots),
    error: reference.error,
    loading: reference.isPending || (!!reference.data && queries.some((query) => query.isPending)),
    unavailable: snapshots.filter((snapshot) => snapshot.unavailable),
    localOnly: reference.data?.origin === null && hosts.hosts.length > 1,
  };
}
