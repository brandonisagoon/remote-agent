import { queryOptions, useMutation } from "@tanstack/react-query";

import type { ConfigDocument } from "../../../../../lib/config-file.ts";
import { queryClient } from "@renderer/lib/queries/query-client.ts";

/** Latest on-disk document. Push-updated by the main process file watcher
    (see wireConfigStream); never stale-refetched. */
export const configQueryOptions = queryOptions({
  queryKey: ["config"],
  queryFn: () => window.remoteAgent.config.get(),
  staleTime: Infinity,
});

/** Pipes config:changed events into the cache. Call once at startup. */
export function wireConfigStream(): () => void {
  return window.remoteAgent.config.onChange((document: ConfigDocument) => {
    queryClient.setQueryData(configQueryOptions.queryKey, document);
  });
}

/** Writes a draft against the revision it was based on; the resulting
    document becomes the new cache truth. Revision conflicts reject. */
export function useSaveConfig() {
  return useMutation({
    mutationFn: (input: { expectedRevision: string; value: unknown }) =>
      window.remoteAgent.config.save(input),
    onSuccess: (document) => {
      queryClient.setQueryData(configQueryOptions.queryKey, document);
    },
  });
}
