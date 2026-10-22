import { formatForDisplay, parseHotkey, useHeldKeys } from "@tanstack/react-hotkeys";
import { Link, useMatchRoute } from "@tanstack/react-router";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { jumpChord, useKeybindings, useKeybindingLabel } from "@renderer/lib/keybindings.tsx";
import { useSidebarItems } from "@renderer/lib/sidebar-items.ts";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { NavHistoryButtons } from "@renderer/components/nav-history-buttons.tsx";
import { RemovableSidebarItem } from "@renderer/components/removable-sidebar-item.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { MachineBadge } from "./machine-badge.tsx";
import { MachinesSidebarGroup } from "@renderer/components/machines-sidebar-group.tsx";
import { useHost, useHostDirectory } from "@renderer/lib/host-context.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar.tsx";

export function AppSidebar({
  onAddRepository,
  onRemoveRepository,
}: {
  onAddRepository(): void;
  onRemoveRepository(hostId: string, id: string): void;
}) {
  const addRepositoryLabel = useKeybindingLabel("add-repository");
  const matchRoute = useMatchRoute();
  const { host, api } = useHost();
  const { hosts, entries } = useHostDirectory();
  const items = useSidebarItems();
  // While the configured jump-item modifiers are held, items show their number.
  const bindings = useKeybindings();
  const heldKeys = useHeldKeys();
  const jumpModifiers = parseHotkey(`${bindings["jump-item"]}+1`).modifiers;
  const modHeld = jumpModifiers.length > 0 && jumpModifiers.every((key) => heldKeys.includes(key));
  const repositories = items.filter((item) => item.kind === "repository");
  const repositoryOrdinal = (index: number) => hosts.hosts.length + 1 + index;
  const jumpBadge = (ordinal: number) =>
    modHeld && ordinal <= 9 ? (
      <SidebarMenuBadge>
        <KbdGroup>
          {formatForDisplay(jumpChord(bindings, ordinal)).split(" ").map((key) => (
            <Kbd key={key} className="w-5">
              {key}
            </Kbd>
          ))}
        </KbdGroup>
      </SidebarMenuBadge>
    ) : null;
  return (
    <Sidebar>
      <SidebarHeader className="titlebar-drag h-12 flex-row items-center justify-end pr-2">
        <NavHistoryButtons />
      </SidebarHeader>
      <SidebarContent className="overscroll-contain">
        <MachinesSidebarGroup badge={(index) => jumpBadge(index + 1)} />
        <SidebarGroup>
          <SidebarGroupLabel>Repositories</SidebarGroupLabel>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction onClick={onAddRepository}>
                <F7Icon name="plus" />
                <span className="sr-only">Add a Repository</span>
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="right" className="flex items-center gap-1.5">
              Add a Repository to {host.name}{" "}
              <KbdGroup>
                {addRepositoryLabel.split(" ").map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
          <SidebarGroupContent>
            <SidebarMenu>
              {entries.filter((entry) => entry.loading || entry.error).map(({ host: source, loading, retry }) => (
                <SidebarMenuItem key={`status:${source.id}`}>
                  <SidebarMenuButton onClick={retry} disabled={loading} className="text-muted-foreground text-xs">
                    {loading ? `Loading ${source.name}…` : `Reconnect to ${source.name}`}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {repositories.map((item, index) => (
                <RemovableSidebarItem
                  key={item.key}
                  label={`${item.label} on ${item.hostName}`}
                  description="The checkout and its worktrees stay on disk; only the configuration entry is removed."
                  onRemove={() => onRemoveRepository(item.hostId, item.id)}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={!!matchRoute({ to: "/repositories/$repositoryId", params: { repositoryId: item.id }, search: { host: item.hostId }, includeSearch: true, fuzzy: true })}
                    >
                      <Link to="/repositories/$repositoryId" params={{ repositoryId: item.id }} search={{ host: item.hostId }}>
                        <F7Icon name="folder" />
                        <span className="min-w-0 truncate">{item.label}</span>
                        <MachineBadge name={item.hostName} unavailable={item.unavailable} />
                      </Link>
                    </SidebarMenuButton>
                    {jumpBadge(repositoryOrdinal(index))}
                  </SidebarMenuItem>
                </RemovableSidebarItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* h-7 + no vertical padding: the icon row occupies the same 28px band
          as the inset's path bar so the two footers align. */}
      <SidebarFooter className="h-7 flex-row items-center justify-end gap-1 px-2 py-0">
        <div className="flex justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 [&_svg]:size-3.5"
                onClick={() => void window.remoteAgent.keybindings.openInEditor()}
              >
                <F7Icon name="keyboard" />
                <span className="sr-only">Keyboard Shortcuts</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit Keyboard Shortcuts</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 [&_svg]:size-3.5"
                onClick={() => void api.config.openInEditor()}
              >
                <F7Icon name="gear_alt" />
                <span className="sr-only">Settings</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit Settings JSON</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
