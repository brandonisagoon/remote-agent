import { queryOptions } from "@tanstack/react-query";

import type { Keybindings } from "../../../../shared.ts";
import { queryClient } from "@renderer/lib/queries/query-client.ts";

/** Raw keybindings.json content; push-updated by the file watcher. */
export const keybindingsQueryOptions = queryOptions({
  queryKey: ["keybindings"],
  queryFn: () => window.remoteAgent.keybindings.get(),
  staleTime: Infinity,
});

export function wireKeybindingsStream(): () => void {
  return window.remoteAgent.keybindings.onChange((bindings: Keybindings) => {
    queryClient.setQueryData(keybindingsQueryOptions.queryKey, bindings);
  });
}
