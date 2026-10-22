import { createContext, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DesktopHost, DesktopHostStatus, DesktopHosts } from "../../../../../lib/desktop-host.ts";

interface HostContextValue {
  host: DesktopHost; hosts: DesktopHosts; status?: DesktopHostStatus; switching: boolean;
  dirty: boolean; setDirty(value: boolean): void; select(id: string): Promise<void>; reconnect(): void;
}
const HostContext = createContext<HostContextValue | null>(null);
export function HostProvider({ children }: { children: React.ReactNode }) {
  const hosts = useQuery({ queryKey: ["desktop-hosts"], queryFn: () => window.remoteAgent.hosts.list(), staleTime: Infinity });
  const status = useQuery({ queryKey: ["desktop-host-status"], queryFn: () => window.remoteAgent.hosts.status(), refetchInterval: 5000, retry: false, enabled: !!hosts.data });
  const [dirty, setDirty] = useState(false);
  const [switching, setSwitching] = useState(false);
  if (!hosts.data) return <div className="grid h-screen place-items-center text-sm">{hosts.error ? String(hosts.error) : "Opening your machines…"}</div>;
  const host = hosts.data.hosts.find((entry) => entry.id === hosts.data.activeId)!;
  const select = async (id: string) => {
    if (dirty || switching || id === host.id) return;
    setSwitching(true);
    try { await window.remoteAgent.hosts.select(id); window.location.hash = "/machine"; window.location.reload(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); setSwitching(false); }
  };
  return <HostContext.Provider value={{ host, hosts: hosts.data, status: status.data, dirty, setDirty, switching, select, reconnect: () => { void status.refetch(); } }}>{children}</HostContext.Provider>;
}
export function useHost() { const value = useContext(HostContext); if (!value) throw new Error("Host provider missing"); return value; }
