import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import type { ServiceFile } from "../../../../lib/config.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { tunnelInfoQueryOptions } from "@renderer/lib/queries/tunnel.ts";

function CellCopy({ value, label }: { value: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          <F7Icon name="doc_on_doc" className="size-3" />
          <span className="sr-only">Copy {label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Copy</TooltipContent>
    </Tooltip>
  );
}

/** The records to create at your DNS provider so publicUrl reaches this
    machine's Cloudflare tunnel. */
export function DnsRecordsTable({ value }: { value: ServiceFile }) {
  const tunnelName = value.machine.installation.tunnelName ?? value.serviceName;
  const { data: tunnel } = useQuery(tunnelInfoQueryOptions(tunnelName));
  let hostname: string | null = null;
  try {
    hostname = new URL(value.machine.server.publicUrl).hostname;
  } catch {
    hostname = null;
  }
  if (!hostname) return null;
  const content = tunnel?.tunnelId ? `${tunnel.tunnelId}.cfargotunnel.com` : null;
  const copyTable = async () => {
    await navigator.clipboard.writeText(`CNAME\t${hostname}\t${content ?? ""}\tProxied`);
    toast.success("DNS records copied");
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>DNS Records</Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => void copyTable()}>
              <F7Icon name="doc_on_doc" className="size-3" />
              <span className="sr-only">Copy DNS Records</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy Table</TooltipContent>
        </Tooltip>
      </div>
      <div className="bg-background rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>Proxy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>CNAME</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1">
                  {hostname}
                  <CellCopy value={hostname} label="Name" />
                </span>
              </TableCell>
              <TableCell>
                {content ? (
                  <span className="inline-flex items-center gap-1">
                    {content}
                    <CellCopy value={content} label="Content" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {tunnel?.reason === "cli-missing" ? "cloudflared not installed" : "tunnel not created"}
                  </span>
                )}
              </TableCell>
              <TableCell>Proxied</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        Create this record at your DNS provider so the public URL reaches the machine's Cloudflare
        tunnel.
      </p>
    </div>
  );
}
