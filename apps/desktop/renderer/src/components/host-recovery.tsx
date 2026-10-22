import { useNavigate } from "@tanstack/react-router";
import { useHost } from "@renderer/lib/host-context.tsx";
import { navigateToItem, useSidebarItems } from "@renderer/lib/sidebar-items.ts";
import { Button } from "./ui/button.tsx";
import { F7Icon } from "./f7-icon.tsx";
import { MachineBadge } from "./machine-badge.tsx";
import { NavHistoryButtons } from "./nav-history-buttons.tsx";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarProvider, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "./ui/sidebar.tsx";

/** A failed host never hides the rest of the directory. */
export function HostRecoveryLayout({ children }: { children: React.ReactNode }) {
  const items = useSidebarItems();
  const navigate = useNavigate();
  return <SidebarProvider>
    <Sidebar>
      <SidebarHeader className="titlebar-drag h-12 flex-row items-center justify-end pr-2"><NavHistoryButtons /></SidebarHeader>
      <SidebarContent>
        {(["provider", "connection", "machine", "repository"] as const).map((kind) => <SidebarGroup key={kind}>
          <SidebarGroupLabel>{{ provider: "Providers", connection: "Connections", machine: "Machines", repository: "Repositories" }[kind]}</SidebarGroupLabel>
          <SidebarMenu>{items.filter((item) => item.kind === kind).map((item) => <SidebarMenuItem key={item.key}>
            <SidebarMenuButton onClick={() => navigateToItem(navigate, item)}>
              <F7Icon name={kind === "repository" ? "folder" : "desktopcomputer"} />
              <span className="min-w-0 truncate">{item.label}</span>
              {kind !== "machine" && <MachineBadge name={item.hostName} unavailable={item.unavailable} />}
            </SidebarMenuButton>
          </SidebarMenuItem>)}</SidebarMenu>
        </SidebarGroup>)}
      </SidebarContent>
    </Sidebar>
    <SidebarInset>{children}</SidebarInset>
  </SidebarProvider>;
}

export function UnavailableHost({ error, retry }: { error: string; retry(): void }) {
  const { host } = useHost();
  return <HostRecoveryLayout>
    <main className="bg-background grid min-h-screen place-items-center p-8">
      <div className="grid max-w-xl gap-4">
        <h1 className="text-xl font-semibold">Connect to {host.name}</h1>
        <p className="text-muted-foreground text-sm">Work already started there continues independently. Reconnect to see its latest state.</p>
        <p className="text-muted-foreground break-words text-xs">{error}</p>
        <Button className="justify-self-start" onClick={retry}>Reconnect</Button>
      </div>
    </main>
  </HostRecoveryLayout>;
}
