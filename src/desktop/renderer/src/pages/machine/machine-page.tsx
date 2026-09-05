import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ServiceFile } from "../../../../../lib/config.ts";
import type { ManagementResult } from "../../../../../management/service.ts";
import { DnsRecordsTable } from "./dns-records-table.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { CopyField } from "@renderer/components/copy-field.tsx";
import { Field } from "@renderer/components/field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { StatusDot } from "@renderer/components/status-dot.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
import {
  Table,
  TableBody,
  TableCell,
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

/** The stdio bridge an ACP app runs to reach the daemon: the deployed copy
    under the install root, pointed at this config file. */
function useAcpBridgeCommand(file: ServiceFile): string {
  const { data: configFile = "" } = useQuery({
    queryKey: ["config-path"],
    queryFn: () => window.remoteAgent.config.path(),
    staleTime: Infinity,
  });
  const root =
    file.machine.installation.root ??
    `~/Library/Application Support/${file.serviceName}`;
  return `REMOTE_AGENT_CONFIG='${configFile}' bun '${root.replace(/\/$/, "")}/app/src/acp/main.ts'`;
}

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
  const bridgeCommand = useAcpBridgeCommand(value);
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
    check("cli"),
    check("service"),
    check("tunnel"),
  ].filter((entry) => entry !== undefined);
  const statusRows = [check("daemon"), check("acp"), check("config"), check("repositories")].filter(
    (entry) => entry !== undefined,
  );
  // Remedies are "run: <cmd>" / "install with: <cmd>"; the button hands the
  // command to the user's terminal rather than running it from the app.
  const remedyCommand = (step: { remedy?: string }) =>
    step.remedy?.match(/^(?:run|install with): (.+)$/)?.[1] ?? null;
  const openTerminal = async (commandLine: string) => {
    setResult(await window.remoteAgent.management.openTerminal(commandLine));
  };
  const stepAction = (step: NonNullable<ReturnType<typeof check>>) => {
    if (step.id === "cli") {
      return (
        <Button size="sm" variant="outline" disabled={working !== null || step.status === "ok"} onClick={() => void act("install-cli")}>
          Install
        </Button>
      );
    }
    if (step.id === "service") {
      return (
        <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void act("install")}>
          {step.status === "ok" ? "Reinstall" : "Install"}
        </Button>
      );
    }
    const command = remedyCommand(step);
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={working !== null || step.status === "ok" || !command}
        onClick={() => command && void openTerminal(command)}
      >
        {step.id === "tunnel" ? "Create" : "Install"}
      </Button>
    );
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
        <div className="bg-background -mx-4 rounded-lg border">
          <Table className="table-fixed">
            <TableBody>
              {installSteps.map((step) => (
                <TableRow key={step.id} className="h-14">
                  <TableCell className="pl-4">
                    <div>{step.label}</div>
                    {(step.status === "ok" ? null : (step.remedy ?? step.detail)) && (
                      <div className="text-muted-foreground truncate text-xs">{step.remedy ?? step.detail}</div>
                    )}
                  </TableCell>
                  <TableCell className="w-28"><StatusDot status={step.status} /></TableCell>
                  <TableCell className="w-48 pr-4 text-right">{stepAction(step)}</TableCell>
                </TableRow>
              ))}
              {installSteps.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground text-center">Checking…</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <SettingsSection value="status" title="Status" description="The running system.">
        <div className="bg-background -mx-4 rounded-lg border">
          <Table className="table-fixed">
            <TableBody>
              {statusRows.map((row) => (
                <TableRow key={row.id} className="h-14">
                  <TableCell className="pl-4">
                    <div>{row.label}</div>
                    {row.detail && (
                      <div className="text-muted-foreground truncate text-xs">{row.detail}</div>
                    )}
                  </TableCell>
                  <TableCell className="w-28"><StatusDot status={row.status} /></TableCell>
                  <TableCell className="w-48 pr-4 text-right">
                    {row.id === "daemon" && (
                      <Button size="sm" variant="outline" disabled={working !== null} onClick={() => void act("restart")}>
                        <F7Icon name="arrow_clockwise" className={cn(working === "restart" && "animate-spin")} />
                        Restart
                      </Button>
                    )}
                    {row.id === "config" && (
                      <Button size="sm" variant="outline" onClick={() => void window.remoteAgent.config.openInEditor()}>
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="h-14">
                <TableCell className="pl-4">Updates</TableCell>
                <TableCell className="w-28"><span className="text-muted-foreground text-xs">—</span></TableCell>
                <TableCell className="w-48 pr-4 text-right">
                  <div className="flex justify-end gap-2">
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
          <div className="bg-background -mx-4 rounded-lg border p-3 text-sm">
            <div className={cn("font-medium", !result.ok && "text-destructive")}>{result.summary}</div>
            {result.detail && (
              <pre className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">{result.detail}</pre>
            )}
          </div>
        )}
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
        description="ACP apps — Zed, bb, T3 Code — attach to this machine's running sessions through the ACP socket. Configure the app to run the bridge command below as its agent server: it speaks ACP over stdio and forwards everything to the daemon, which must be running."
      >
        <SettingsCard>
          <CopyField label="Bridge Command" value={bridgeCommand} />
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

