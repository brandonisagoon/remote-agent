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
    try { await window.remoteAgent.hosts.select(id); window.location.reload(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); setSwitching(false); }
  };
  return <HostContext.Provider value={{ host, hosts: hosts.data, status: status.data, dirty, setDirty, switching, select, reconnect: () => { void status.refetch(); } }}>{children}</HostContext.Provider>;
}
export function useHost() { const value = useContext(HostContext); if (!value) throw new Error("Host provider missing"); return value; }

export function MachineSwitcher() {
  const { host, hosts, status, select, dirty, switching, reconnect } = useHost();
  const label = !status ? "Connecting…" : !status.connected ? "Disconnected" : !status.serverAvailable ? "Server unavailable" : "Connected";
  return <div className="titlebar-no-drag flex shrink-0 items-center gap-2 text-xs">
    <label className="sr-only" htmlFor="selected-machine">Machine</label>
    <select id="selected-machine" aria-label="Machine" value={host.id} disabled={dirty || switching} title={dirty ? "Save or revert changes before switching machines" : "Choose the machine to manage"} onChange={(event) => void select(event.target.value)} className="bg-background max-w-44 rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring">
      {hosts.hosts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select>
    <button onClick={reconnect} title={status?.detail ?? label} className="text-muted-foreground flex items-center gap-1.5 rounded px-1 py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className={`size-1.5 rounded-full ${status?.connected && status.serverAvailable ? "bg-emerald-500" : "bg-amber-500"}`} />{label}
    </button>
  </div>;
}

export function UnavailableHost({ error, retry }: { error: string; retry(): void }) {
  const { host } = useHost();
  return <main className="bg-background grid h-screen place-items-center p-8"><div className="grid max-w-xl gap-4"><MachineSwitcher /><h1 className="text-xl font-semibold">Connect to {host.name}</h1><p className="text-muted-foreground text-sm">Work already started there continues independently. Reconnect to see its latest state.</p><p className="text-muted-foreground break-words text-xs">{error}</p><button className="bg-primary text-primary-foreground justify-self-start rounded-md px-4 py-2 text-sm" onClick={retry}>Reconnect</button></div></main>;
}
