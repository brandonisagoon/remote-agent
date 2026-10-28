import { queryOptions } from "@tanstack/react-query";

/** Scanned from the installed provider binary; cheap but not free, so cache
    generously — the binary only changes when the CLI is upgraded. */
export function providerModelsQueryOptions(hostId: string, providerId: string) {
  return queryOptions({
    queryKey: ["provider-models", hostId, providerId],
    queryFn: () => window.remoteAgent.forHost(hostId).provider.models(providerId),
    staleTime: 5 * 60 * 1000,
  });
}
