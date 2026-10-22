import { useHost } from "@renderer/lib/host-context.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { MachinesSidebarGroup } from "@renderer/components/machines-sidebar-group.tsx";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar.tsx";

/** Keep machine navigation reachable when its configuration cannot be read. */
export function HostRecoveryLayout({ children }: { children: React.ReactNode }) {
  const { reconnect } = useHost();
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="titlebar-drag h-12" />
        <SidebarContent>
          <MachinesSidebarGroup active onOpen={reconnect} />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}

export function UnavailableHost({ error, retry }: { error: string; retry(): void }) {
  const { host } = useHost();
  return (
    <HostRecoveryLayout>
      <main className="bg-background grid min-h-screen place-items-center p-8">
        <div className="grid max-w-xl gap-4">
          <h1 className="text-xl font-semibold">Connect to {host.name}</h1>
          <p className="text-muted-foreground text-sm">Work already started there continues independently. Reconnect to see its latest state.</p>
          <p className="text-muted-foreground break-words text-xs">{error}</p>
          <Button className="justify-self-start" onClick={retry}>Reconnect</Button>
        </div>
      </main>
    </HostRecoveryLayout>
  );
}
