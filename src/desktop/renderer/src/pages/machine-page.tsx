import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ServiceFile } from "../../../../lib/config.ts";
import type { ManagementResult } from "../../../../management/service.ts";
import { DnsRecordsTable } from "@renderer/components/dns-records-table.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Badge } from "@renderer/components/ui/badge.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@renderer/components/ui/table.tsx";
import { checksQueryOptions } from "@renderer/lib/queries/checks.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select.tsx";
import type { Mutate } from "@renderer/lib/types.ts";
import { cn } from "@renderer/lib/utils.ts";

export function MachinePage({ value, mutate }: { value: ServiceFile; mutate: Mutate }) {
  const [result, setResult] = useState<ManagementResult | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const run = async (action: "status" | "doctor" | "install" | "install-cli" | "check-update" | "update" | "restart") => {
    setWorking(action);
    try {
      setResult(await window.remoteAgent.management.run(action));
    } finally {
      setWorking(null);
    }
  };
  const machine = value.machine;
  const queryClient = useQueryClient();
  const { data: checks = [] } = useQuery(checksQueryOptions);
  const check = (id: string) => checks.find((entry) => entry.id === id);
  const act = async (action: Parameters<typeof run>[0]) => {
    await run(action);
    void queryClient.invalidateQueries({ queryKey: checksQueryOptions.queryKey });
  };
  const installSteps = [
    check("bun"),
    check("cloudflared"),
    ...checks.filter((entry) => entry.id.startsWith("provider-")),
    check("cli"),
    check("service"),
    check("tunnel"),
  ].filter((entry) => entry !== undefined);
  const statusRows = [check("daemon"), check("config"), check("repositories")].filter(
    (entry) => entry !== undefined,
  );
  const stepAction = (id: string) => {
    if (id === "cli") {
      return (
        <Button size="sm" variant="outline" disabled={working !== null || check("cli")?.status === "ok"} onClick={() => void act("install-cli")}>
          Install
        </Button>
      );
    }
    if (id === "service") {
      return (
        <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void act("install")}>
          {check("service")?.status === "ok" ? "Reinstall" : "Install"}
        </Button>
      );
    }
    return null;
  };
  return (
    <Accordion
      type="multiple"
      defaultValue={["installation", "status", "identity", "server", "remote-access", "acp", "storage"]}
      className="-mt-4"
    >
      <SettingsSection
        value="installation"
        title="Installation"
        description="Everything this machine needs, in order. Each step reports its own state."
      >
        <SettingsCard>
          <div className="bg-background rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {installSteps.map((step, index) => (
                  <TableRow key={step.id}>
                    <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <div>{step.label}</div>
                      {(step.status === "ok" ? null : (step.remedy ?? step.detail)) && (
                        <div className="text-muted-foreground truncate text-xs">{step.remedy ?? step.detail}</div>
                      )}
                    </TableCell>
                    <TableCell><CheckBadge status={step.status} /></TableCell>
                    <TableCell>{stepAction(step.id)}</TableCell>
                  </TableRow>
                ))}
                {installSteps.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground text-center">Checking…</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection value="status" title="Status" description="The running system.">
        <SettingsCard>
          <div className="bg-background rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {statusRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div>{row.label}</div>
                      {row.detail && (
                        <div className="text-muted-foreground truncate text-xs">{row.detail}</div>
                      )}
                    </TableCell>
                    <TableCell><CheckBadge status={row.status} /></TableCell>
                    <TableCell>
                      {row.id === "daemon" && (
                        <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void act("restart")}>
                          <F7Icon name="arrow_clockwise" className={cn(working === "restart" && "animate-spin")} />
                          Restart
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>Updates</TableCell>
                  <TableCell><span className="text-muted-foreground text-xs">—</span></TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void act("check-update")}>
                        Check
                      </Button>
                      <Button size="sm" disabled={working !== null} onClick={() => void act("update")}>
                        Install
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {result && (
            <div className="bg-background rounded-md border p-3 text-sm">
              <div className={cn("font-medium", !result.ok && "text-destructive")}>{result.summary}</div>
              {result.detail && (
                <pre className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">{result.detail}</pre>
              )}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection value="identity" title="Identity">
        <SettingsCard>
          <Field label="Machine ID" value={machine.id} onChange={(next) => mutate((file) => { file.machine.id = next; })} />
          <Field label="Display name" value={machine.name} onChange={(next) => mutate((file) => { file.machine.name = next; })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        value="server"
        title="Server"
        description="Where the daemon listens for HTTP. Changing these requires a daemon restart."
      >
        <SettingsCard>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Host" value={machine.server.listen.host} onChange={(next) => mutate((file) => { file.machine.server.listen.host = next; })} />
            <Field label="Port" type="number" value={machine.server.listen.port} onChange={(next) => mutate((file) => { file.machine.server.listen.port = Number(next); })} />
          </div>
          <Field label="Public URL" value={machine.server.publicUrl} onChange={(next) => mutate((file) => { file.machine.server.publicUrl = next; })} />
          <DnsRecordsTable value={value} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        value="acp"
        title="ACP"
        description="Unix sockets for the Agent Client Protocol bridge and its control channel."
      >
        <SettingsCard>
          <Field label="ACP socket" value={machine.server.acpSocketPath ?? ""} onChange={(next) => mutate((file) => { file.machine.server.acpSocketPath = next; })} />
          <Field label="Control socket" value={machine.server.controlSocketPath ?? ""} onChange={(next) => mutate((file) => { file.machine.server.controlSocketPath = next; })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection value="storage" title="Storage">
        <SettingsCard>
          <Field label="Database URL" value={machine.server.databaseUrl ?? ""} onChange={(next) => mutate((file) => { file.machine.server.databaseUrl = next; })} />
          <Field label="Session State Directory" description="Where acpx persists each session's conversation state." value={machine.acpx.stateDir ?? ""} onChange={(next) => mutate((file) => { file.machine.acpx.stateDir = next; })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        value="remote-access"
        title="Remote Access"
        description="The SSH address editors use to open this machine's worktrees. Leave blank if your editors run on this machine."
      >
        <SettingsCard>
          <Field
            label="SSH Host"
            placeholder="user@host"
            value={machine.sshHost ?? ""}
            onChange={(next) => mutate((file) => { file.machine.sshHost = next || undefined; })}
          />
        </SettingsCard>
      </SettingsSection>


    </Accordion>
  );
}

function CheckBadge({ status }: { status: "ok" | "warn" | "fail" }) {
  if (status === "ok") return <Badge variant="secondary">OK</Badge>;
  if (status === "warn") return <Badge variant="outline">Attention</Badge>;
  return <Badge variant="destructive">Missing</Badge>;
}
