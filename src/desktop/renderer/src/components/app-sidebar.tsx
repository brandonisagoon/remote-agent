import { formatForDisplay, parseHotkey, useHeldKeys } from "@tanstack/react-hotkeys";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import type { ServiceFile } from "../../../../lib/config.ts";
import { BrandIcon } from "@renderer/components/brand-icon.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { jumpChord, useKeybindings } from "@renderer/lib/keybindings.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { Badge } from "@renderer/components/ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { NavHistoryButtons } from "@renderer/components/nav-history-buttons.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
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
  value,
  onAddProvider,
  onAddConnection,
  onAddRepository,
}: {
  value: ServiceFile;
  onAddProvider(id: "codex" | "claude"): void;
  onAddConnection(): void;
  onAddRepository(): void;
}) {
  const matchRoute = useMatchRoute();
  // While the configured jump-item modifiers are held, items show their number.
  const bindings = useKeybindings();
  const heldKeys = useHeldKeys();
  const jumpModifiers = parseHotkey(`${bindings["jump-item"]}+1`).modifiers;
  const modHeld = jumpModifiers.length > 0 && jumpModifiers.every((key) => heldKeys.includes(key));
  const providers = Object.keys(value.providers);
  const connections = Object.entries(value.connections);
  const repositories = Object.entries(value.repositories);
  const connectionOrdinal = (index: number) => providers.length + 1 + index;
  const machineOrdinal = providers.length + connections.length + 1;
  const repositoryOrdinal = (index: number) => machineOrdinal + 1 + index;
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
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Providers</SidebarGroupLabel>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarGroupAction title="Add provider">
                <F7Icon name="plus" />
              </SidebarGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem disabled={providers.includes("codex")} onSelect={() => onAddProvider("codex")}>
                <BrandIcon name="openai" />
                Codex
              </DropdownMenuItem>
              <DropdownMenuItem disabled={providers.includes("claude")} onSelect={() => onAddProvider("claude")}>
                <BrandIcon name="claudecode" />
                Claude Code
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarGroupContent>
            <SidebarMenu>
              {providers.map((providerId, index) => (
                <SidebarMenuItem key={providerId}>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/providers/$providerId", params: { providerId } })}
                  >
                    <Link to="/providers/$providerId" params={{ providerId }}>
                      {providerId === "claude" ? <BrandIcon name="claudecode" /> : <BrandIcon name="openai" />}
                      <span>{PROVIDER_LABELS[providerId] ?? providerId}</span>
                    </Link>
                  </SidebarMenuButton>
                  {jumpBadge(index + 1)}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Connections</SidebarGroupLabel>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarGroupAction title="Add connection">
                <F7Icon name="plus" />
              </SidebarGroupAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem onSelect={onAddConnection}>
                <BrandIcon name="linear" />
                Linear
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <MessagesSquareIcon />
                Slack
                <Badge variant="secondary" className="ml-auto">
                  Coming soon
                </Badge>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <BrandIcon name="github" />
                GitHub
                <Badge variant="secondary" className="ml-auto">
                  Coming soon
                </Badge>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarGroupContent>
            <SidebarMenu>
              {connections.map(([id, connection], index) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/connections/$connectionId", params: { connectionId: id } })}
                  >
                    <Link to="/connections/$connectionId" params={{ connectionId: id }}>
                      <BrandIcon name="linear" />
                      <span>{connection.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  {jumpBadge(connectionOrdinal(index))}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Machines</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={!!matchRoute({ to: "/" })}>
                  <Link to="/">
                    <F7Icon name="desktopcomputer" />
                    <span>{value.machine.name}</span>
                  </Link>
                </SidebarMenuButton>
                {jumpBadge(machineOrdinal)}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Repositories</SidebarGroupLabel>
          <SidebarGroupAction title="Add repository" onClick={onAddRepository}>
            <F7Icon name="plus" />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {repositories.map(([id, repository], index) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    asChild
                    isActive={!!matchRoute({ to: "/repositories/$repositoryId", params: { repositoryId: id } })}
                  >
                    <Link to="/repositories/$repositoryId" params={{ repositoryId: id }}>
                      <F7Icon name="folder" />
                      <span>{repository.name ?? id}</span>
                    </Link>
                  </SidebarMenuButton>
                  {jumpBadge(repositoryOrdinal(index))}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
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
                className="size-7"
                onClick={() => void window.remoteAgent.config.openInEditor()}
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
