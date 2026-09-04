import { Link } from "@tanstack/react-router";

import type { ServiceFile } from "../../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Checkbox } from "@renderer/components/ui/checkbox.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@renderer/components/ui/input-group.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

export function MachineScopeEditor({
  connectionId,
  value,
  mutate,
}: {
  connectionId: string;
  value: ServiceFile;
  mutate: Mutate;
}) {
  const connection = value.connections[connectionId]!;
  const repositories = connection.repositories;
  const routingMode = repositories === "*" ? "all" : "select";
  const routingTargets =
    repositories === "*" ? Object.keys(value.repositories) : Object.keys(repositories);
  const toggleRepository = (repositoryId: string, checked: boolean) => {
    mutate((file) => {
      const scope = file.connections[connectionId]!;
      const routing = scope.repositories === "*"
        ? Object.fromEntries(Object.keys(file.repositories).map((repo) => [repo, {}]))
        : scope.repositories;
      if (checked) routing[repositoryId] = routing[repositoryId] ?? {};
      else delete routing[repositoryId];
      scope.repositories = routing;
    });
  };
  return (
    <>
      <div className="grid gap-2">
        <Label>Machine</Label>
        <InputGroup>
          {/* Span wrapper: the disabled trigger swallows pointer events, so the
              tooltip listens on a live ancestor instead. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-1">
                <Select value={connection.machineId ?? value.machine.id} disabled>
                  <SelectTrigger className="w-full border-0 bg-transparent shadow-none dark:bg-transparent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={connection.machineId ?? value.machine.id}>{value.machine.name}</SelectItem>
                  </SelectContent>
                </Select>
              </span>
            </TooltipTrigger>
            <TooltipContent>Multi-machine support coming soon</TooltipContent>
          </Tooltip>
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <InputGroupButton size="icon-xs" asChild>
                  <Link to="/">
                    <F7Icon name="desktopcomputer" />
                    <span className="sr-only">Open machine settings</span>
                  </Link>
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>Machine Settings</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className="grid gap-2">
        <Label>Repositories</Label>
        <Tabs
          value={routingMode}
          onValueChange={(mode) => {
            mutate((file) => {
              const scope = file.connections[connectionId]!;
              if (mode === "all") {
                scope.repositories = "*";
              } else if (scope.repositories === "*") {
                scope.repositories = Object.fromEntries(
                  Object.keys(file.repositories).map((repositoryId) => [repositoryId, {}]),
                );
              }
            });
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="select">Selected</TabsTrigger>
          </TabsList>
        </Tabs>
        {routingMode === "select" && (
          <div className="grid grid-cols-2 gap-2 pt-2 pb-4">
            {Object.entries(value.repositories).map(([repositoryId, repository]) => {
              const checked = routingTargets.includes(repositoryId);
              const conditional =
                repositories !== "*" && (repositories[repositoryId]?.when?.length ?? 0) > 0;
              return (
                <label key={repositoryId} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    disabled={checked && routingTargets.length === 1}
                    onCheckedChange={(next) => toggleRepository(repositoryId, next === true)}
                  />
                  <span className="truncate">{repository.name ?? repositoryId}</span>
                  {conditional && <span className="text-muted-foreground text-xs">(conditional)</span>}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
