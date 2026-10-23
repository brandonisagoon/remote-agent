import { Link } from "@tanstack/react-router";
import { BrandIcon } from "@renderer/components/brand-icon.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@renderer/components/ui/dropdown-menu.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@renderer/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import { useMachineActions } from "./use-machine-actions.ts";

export function ProvidersTab() {
  const { draft } = useConfig();
  const { host } = useHost();
  const { addProvider } = useMachineActions();
  const providers = Object.keys(draft.providers);
  return (
    <div className="-mx-4 overflow-hidden rounded-lg border">
      <Table className="table-fixed">
        <TableHeader><TableRow><TableHead className="px-4">Provider</TableHead></TableRow></TableHeader>
        <TableBody>
          {providers.map((providerId) => (
            <TableRow key={providerId} className="h-14">
              <TableCell className="p-0">
                <Link to="/machine/providers/$providerId" params={{ providerId }} search={{ host: host.id }} className="flex h-14 items-center gap-3 px-4 font-medium focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2">
                  <BrandIcon name={providerId === "claude" ? "claudecode" : "openai"} />
                  <span className="truncate">{PROVIDER_LABELS[providerId] ?? providerId}</span>
                  <F7Icon name="chevron_right" className="text-muted-foreground ml-auto" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {providers.length === 0 && <p className="text-muted-foreground p-6 text-center text-sm">No providers configured on {host.name}.</p>}
      <div className="flex items-center border-t px-1 py-0.5">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild><DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" disabled={providers.length === 2}>
                <F7Icon name="plus" className="size-3.5" /><span className="sr-only">Add Provider</span>
              </Button>
            </DropdownMenuTrigger></TooltipTrigger>
            <TooltipContent>Add Provider to {host.name}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled={!!draft.providers.codex} onSelect={() => addProvider("codex")}><BrandIcon name="openai" />Codex</DropdownMenuItem>
            <DropdownMenuItem disabled={!!draft.providers.claude} onSelect={() => addProvider("claude")}><BrandIcon name="claudecode" />Claude Code</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
