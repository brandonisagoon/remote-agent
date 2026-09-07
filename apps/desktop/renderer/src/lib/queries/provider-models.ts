import { queryOptions } from "@tanstack/react-query";

/** Scanned from the installed provider binary; cheap but not free, so cache
    generously — the binary only changes when the CLI is upgraded. */
export function providerModelsQueryOptions(providerId: string) {
  return queryOptions({
    queryKey: ["provider-models", providerId],
    queryFn: () => window.remoteAgent.provider.models(providerId),
    staleTime: 5 * 60 * 1000,
  });
}
