import { Link, useMatchRoute } from "@tanstack/react-router";
import { useHostDirectory } from "@renderer/lib/host-context.tsx";
import { F7Icon } from "./f7-icon.tsx";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar.tsx";

export function MachinesSidebarGroup({ badge }: { badge?(index: number): React.ReactNode }) {
  const { entries } = useHostDirectory();
  const matchRoute = useMatchRoute();
  return <SidebarGroup>
    <SidebarGroupLabel>Machines</SidebarGroupLabel>
    <SidebarGroupContent><SidebarMenu>
      {entries.map(({ host, config, error }, index) => <SidebarMenuItem key={host.id}>
        <SidebarMenuButton asChild isActive={!!matchRoute({ to: "/machine", search: { host: host.id }, includeSearch: true, fuzzy: true })}>
          <Link to="/machine" search={{ host: host.id }}>
            <F7Icon name="desktopcomputer" />
            <span className="truncate">{host.name}</span>
            {config.anyDirty && <span className="ml-auto text-xs" aria-label="Unsaved changes">•</span>}
            {error && <span className="text-muted-foreground ml-auto text-xs" title="Unavailable">!</span>}
          </Link>
        </SidebarMenuButton>
        {badge?.(index)}
      </SidebarMenuItem>)}
    </SidebarMenu></SidebarGroupContent>
  </SidebarGroup>;
}
