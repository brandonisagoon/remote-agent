import { useState } from "react";

import type { ServiceFile } from "../../../../lib/config.ts";
import type { ManagementResult } from "../../../../management/service.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Field } from "@renderer/components/field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Accordion } from "@renderer/components/ui/accordion.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Label } from "@renderer/components/ui/label.tsx";
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
  const run = async (action: "status" | "doctor" | "install" | "check-update" | "update" | "restart") => {
    setWorking(action);
    try {
      setResult(await window.remoteAgent.management.run(action));
    } finally {
      setWorking(null);
    }
  };
  const machine = value.machine;
  return (
    <Accordion
      type="multiple"
      defaultValue={["service", "identity", "server", "acp", "storage", "editor", "sessions"]}
      className="-mt-4"
    >
      <SettingsSection value="service" title="Service" description="Install, inspect, and update the local daemon.">
        <SettingsCard>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void run("status")}>
              <F7Icon name="arrow_2_circlepath" className={cn(working === "status" && "animate-spin")} />
              Status
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run("doctor")}>
              <F7Icon name="checkmark_circle" />
              Doctor
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run("install")}>
              <F7Icon name="cube_box" />
              Install Service
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run("restart")}>
              <F7Icon name="arrow_clockwise" />
              Restart
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run("check-update")}>
              <F7Icon name="arrow_2_circlepath" />
              Check Updates
            </Button>
            <Button size="sm" onClick={() => void run("update")}>
              Install Update
            </Button>
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
          <Field label="acpx state directory" value={machine.acpx.stateDir ?? ""} onChange={(next) => mutate((file) => { file.machine.acpx.stateDir = next; })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        value="editor"
        title="Editor"
        description="How “Open in Zed” links reach this machine's checkouts."
      >
        <SettingsCard>
          <div className="grid gap-2">
            <Label>Connection</Label>
            <Select
              value={machine.zed.connection}
              onValueChange={(next) => mutate((file) => { file.machine.zed.connection = next as "local" | "ssh"; })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="ssh">SSH</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {machine.zed.connection === "ssh" && (
            <Field label="SSH host" value={machine.zed.remoteHost ?? ""} onChange={(next) => mutate((file) => { file.machine.zed.remoteHost = next; })} />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        value="sessions"
        title="Sessions"
        description="Defaults for agent sessions run by this machine."
      >
        <SettingsCard>
          <div className="grid gap-2">
            <Label>Permission mode</Label>
            <Select
              value={machine.acpx.permissionMode}
              onValueChange={(next) => mutate((file) => { file.machine.acpx.permissionMode = next as typeof file.machine.acpx.permissionMode; })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approve-all">Approve all</SelectItem>
                <SelectItem value="approve-reads">Approve reads</SelectItem>
                <SelectItem value="deny-all">Deny all</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SettingsCard>
      </SettingsSection>
    </Accordion>
  );
}
