import { queryOptions } from "@tanstack/react-query";

/** Editor apps detected on this machine (with icons); effectively static for
    the app's lifetime. */
export const detectedEditorsQueryOptions = queryOptions({
  queryKey: ["detected-editors"],
  queryFn: () => window.remoteAgent.editors.detect(),
  staleTime: Infinity,
});
