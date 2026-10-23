import { createContext, useContext, useEffect, useReducer, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { DesktopHost, DesktopHosts } from "../../../../../lib/desktop-host.ts";
import type { HostDesktopApi } from "../../../shared.ts";
import { ConfigDraftController } from "./config-draft.ts";
import { configQueryOptions } from "./queries/config.ts";
import { repoConfigsQueryOptions, type RepoConfigDocuments } from "./queries/repo-configs.ts";
import { queryClient } from "./queries/query-client.ts";

export interface HostEntry {
  host: DesktopHost;
  api: HostDesktopApi;
  config: ConfigDraftController;
  loading: boolean;
  error: Error | null;
  retry(): void;
}

const DirectoryContext = createContext<{ hosts: DesktopHosts; entries: HostEntry[] } | null>(null);
const HostContext = createContext<HostEntry | null>(null);

export function HostDirectoryProvider({ children }: { children: React.ReactNode }) {
  const hosts = useQuery({ queryKey: ["desktop-hosts"], queryFn: () => window.remoteAgent.hosts.list(), staleTime: Infinity });
  if (!hosts.data) return <div className="grid h-screen place-items-center text-sm">{hosts.error ? String(hosts.error) : "Opening your machines…"}</div>;
  return <HostDirectory hosts={hosts.data}>{children}</HostDirectory>;
}

function HostDirectory({ hosts, children }: { hosts: DesktopHosts; children: React.ReactNode }) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [controllers] = useState(() => hosts.hosts.map((host) => {
    const api = window.remoteAgent.forHost(host.id);
    const config = new ConfigDraftController(api, refresh,
      (document) => queryClient.setQueryData(configQueryOptions(host.id).queryKey, document),
      (id, document) => queryClient.setQueryData<RepoConfigDocuments>(repoConfigsQueryOptions(host.id).queryKey,
        (current) => ({ ...current, [id]: { ...document, root: current?.[id]?.root ?? "" } })),
    );
    return { host, api, config };
  }));
  const queries = useQueries({ queries: hosts.hosts.map((host) => configQueryOptions(host.id)) });
  useEffect(() => {
    queries.forEach((query, index) => { if (query.data) controllers[index]!.config.receive(query.data); });
  }, [queries, controllers]);
  const entries = controllers.map((entry, index) => ({
    ...entry,
    loading: queries[index]!.isPending,
    error: queries[index]!.error,
    retry: () => { void queries[index]!.refetch(); },
  }));
  return <DirectoryContext.Provider value={{ hosts, entries }}>{children}</DirectoryContext.Provider>;
}

export function useHostDirectory() {
  const value = useContext(DirectoryContext);
  if (!value) throw new Error("Machine directory missing");
  return value;
}

/** A route owns its machine. The directory never filters to that machine. */
export function HostProvider({ children }: { children: React.ReactNode }) {
  const { hosts, entries } = useHostDirectory();
  const { host: requestedId } = useSearch({ strict: false });
  const id = requestedId ?? hosts.activeId;
  const entry = entries.find((candidate) => candidate.host.id === id);
  if (!entry) return <div className="p-8">This machine is no longer configured.</div>;
  return <HostContext.Provider value={entry}>{children}</HostContext.Provider>;
}

export function useHost() {
  const value = useContext(HostContext);
  if (!value) throw new Error("Machine context missing");
  return value;
}
