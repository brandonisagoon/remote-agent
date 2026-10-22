import { useHost } from "@renderer/lib/host-context.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar.tsx";

export function MachinesSidebarGroup({ active, machineName, onOpen, badge }: {
  active: boolean;
  machineName?: string;
  onOpen(): void;
  badge?(index: number): React.ReactNode;
}) {
  const { host, hosts, select, dirty, switching } = useHost();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Machines</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {hosts.hosts.map((machine, index) => (
            <SidebarMenuItem key={machine.id}>
              <SidebarMenuButton
                isActive={active && machine.id === host.id}
                disabled={switching || (dirty && machine.id !== host.id)}
                title={dirty && machine.id !== host.id ? "Save or revert changes before switching machines" : undefined}
                onClick={() => machine.id === host.id ? onOpen() : void select(machine.id)}
              >
                <F7Icon name="desktopcomputer" />
                <span>{hosts.hosts.length === 1 ? machineName ?? machine.name : machine.name}</span>
              </SidebarMenuButton>
              {badge?.(index)}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
