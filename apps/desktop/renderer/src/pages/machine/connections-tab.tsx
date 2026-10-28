import { Link } from "@tanstack/react-router";
import { BrandIcon } from "@renderer/components/brand-icon.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@renderer/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";
import { useMachineActions } from "./use-machine-actions.ts";

export function ConnectionsTab() {
  const { draft } = useConfig();
  const { host } = useHost();
  const { addConnection } = useMachineActions();
  const connections = Object.entries(draft.connections);
  return (
    <div className="-mx-4 overflow-hidden rounded-lg border">
      <Table className="table-fixed">
        <TableHeader><TableRow><TableHead className="px-4">Connection</TableHead></TableRow></TableHeader>
        <TableBody>
          {connections.map(([connectionId, connection]) => (
            <TableRow key={connectionId} className="h-14">
              <TableCell className="p-0">
                <Link to="/machine/connections/$connectionId" params={{ connectionId }} search={{ host: host.id }} className="flex h-14 items-center gap-3 px-4 font-medium focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2">
                  <BrandIcon name="linear" />
                  <span className="truncate">{connection.name}</span>
                  <span className="text-muted-foreground ml-auto text-xs font-normal">Linear</span>
                  <F7Icon name="chevron_right" className="text-muted-foreground" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {connections.length === 0 && <p className="text-muted-foreground p-6 text-center text-sm">No connections configured on {host.name}.</p>}
      <div className="flex items-center border-t px-1 py-0.5">
        <Tooltip>
          <TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6" onClick={addConnection}>
            <F7Icon name="plus" className="size-3.5" /><span className="sr-only">Add Linear Connection</span>
          </Button></TooltipTrigger>
          <TooltipContent>Add Linear Connection to {host.name}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
