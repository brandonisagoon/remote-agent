import { queryOptions, useMutation } from "@tanstack/react-query";

import type { RepoConfigDocument } from "../../../../../../lib/config-file.ts";
import { queryClient } from "@renderer/lib/queries/query-client.ts";

export type RepoConfigDocuments = Record<string, RepoConfigDocument & { root: string }>;

/** Every repository's committed config document, push-updated by the main
    process file watchers — same model as the app config document. */
export const repoConfigsQueryOptions = queryOptions({
  queryKey: ["repo-configs"],
  queryFn: () => window.remoteAgent.repoConfigs.get(),
  staleTime: Infinity,
});

/** Pipes repo-configs:changed events into the cache. Call once at startup. */
export function wireRepoConfigsStream(): () => void {
  return window.remoteAgent.repoConfigs.onChange((documents) => {
    queryClient.setQueryData(repoConfigsQueryOptions.queryKey, documents as RepoConfigDocuments);
  });
}

/** Revision-guarded save of one repository's committed config. */
export function useSaveRepoConfig() {
  return useMutation({
    mutationFn: (input: { id: string; expectedRevision: string; value: unknown }) =>
      window.remoteAgent.repoConfigs.save(input),
    onSuccess: (document, input) => {
      queryClient.setQueryData(
        repoConfigsQueryOptions.queryKey,
        (current: RepoConfigDocuments | undefined) =>
          current
            ? { ...current, [input.id]: { ...document, root: current[input.id]?.root ?? "" } }
            : current,
      );
    },
  });
}
