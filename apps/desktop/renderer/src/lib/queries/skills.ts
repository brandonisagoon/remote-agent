import { queryOptions } from "@tanstack/react-query";

/** A repository's skill-composer scan (installed?, validity, skillsets).
    Keyed by root + skillsRoot so the Skills tab and the workflow editor share
    one cache entry; Refresh invalidates it. */
export function skillsQueryOptions(hostId: string, root: string, skillsRoot: string) {
  return queryOptions({
    queryKey: ["skills", hostId, root, skillsRoot],
    queryFn: () => window.remoteAgent.forHost(hostId).skills.check(root, skillsRoot),
    staleTime: 30_000,
  });
}
