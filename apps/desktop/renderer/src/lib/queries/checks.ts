import { queryOptions } from "@tanstack/react-query";

/** The management checklist (main process). Short stale time + the default
    focus refetch keep the tables honest after the user acts in Terminal;
    action buttons invalidate explicitly. */
export const checksQueryOptions = queryOptions({
  queryKey: ["management-checks"],
  queryFn: () => window.remoteAgent.management.checks(),
  staleTime: 10_000,
});
