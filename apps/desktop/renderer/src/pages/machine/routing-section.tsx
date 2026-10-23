import { useState } from "react";
import type { ServiceFile } from "../../../../../../lib/config.ts";
import { RoutingConfigSchema } from "../../../../../../lib/routing-config.ts";
import { Field } from "@renderer/components/field.tsx";
import { SettingsCard, SettingsSection } from "@renderer/components/settings-section.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

export function RoutingSection({ value, mutate }: { value: ServiceFile; mutate: Mutate }) {
  const [newHost, setNewHost] = useState("");
  const [error, setError] = useState("");
  const routing = value.routing ?? RoutingConfigSchema.parse({});
  const change = (edit: (routing: NonNullable<ServiceFile["routing"]>) => void) => mutate((file) => { file.routing ??= RoutingConfigSchema.parse({}); edit(file.routing); });
  const mode = routing.ingress ? "ingress" : routing.receiverOnly ? "receiver" : "standalone";
  const hosts = [value.machine.id, ...Object.keys(routing.peers)];
  const add = () => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newHost) || hosts.includes(newHost)) { setError("Choose a unique host ID using lowercase letters, numbers and hyphens."); return; }
    change((draft) => { draft.peers[newHost] = { url: "http://127.0.0.1:19002", apiKey: "", repositories: [] }; });
    setNewHost(""); setError("");
  };
  return <SettingsSection value="routing" title="Task routing" description="Choose where new tasks run. Existing tasks keep their recorded host through disconnects and restarts.">
    <SettingsCard>
      <label className="grid gap-2 text-sm">Linear delivery
        <Select value={mode} onValueChange={(mode) => change((draft) => { draft.ingress = mode === "ingress"; draft.receiverOnly = mode === "receiver"; })}>
          <SelectTrigger aria-label="Linear delivery"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="standalone">This host only</SelectItem><SelectItem value="ingress">Receive and route to the chosen host</SelectItem><SelectItem value="receiver">Receive through another host</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {Object.entries(value.connections).map(([id, connection]) => <label key={id} className="grid gap-2 text-sm">New tasks from {connection.name}
        <Select value={routing.connectionHosts[id] ?? value.machine.id} disabled={!routing.ingress} onValueChange={(host) => change((draft) => { draft.connectionHosts[id] = host; })}><SelectTrigger aria-label={`Host for ${connection.name}`}><SelectValue /></SelectTrigger><SelectContent>{hosts.map((host) => <SelectItem key={host} value={host}>{host}</SelectItem>)}</SelectContent></Select>
      </label>)}
    </SettingsCard>
    {Object.entries(routing.peers).map(([id, peer]) => <SettingsCard key={id}>
      <div className="flex items-center justify-between"><strong>{id}</strong><Button variant="outline" size="sm" onClick={() => change((draft) => { delete draft.peers[id]; for (const [connection, host] of Object.entries(draft.connectionHosts)) if (host === id) delete draft.connectionHosts[connection]; })}>Remove host</Button></div>
      <Field label={`${id} address`} value={peer.url} description="Use an HTTPS endpoint or a private local SSH forward." onChange={(next) => change((draft) => { draft.peers[id]!.url = next; })} />
      <Field label={`${id} access key`} type="password" value={peer.apiKey} onChange={(next) => change((draft) => { draft.peers[id]!.apiKey = next; })} />
      <fieldset className="grid gap-2"><legend className="mb-2 text-sm">Allowed repositories</legend>{Object.entries(value.repositories).map(([repositoryId, repository]) => <label key={repositoryId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={peer.repositories.includes(repositoryId)} onChange={(event) => change((draft) => { const selected = new Set(draft.peers[id]!.repositories); if (event.target.checked) selected.add(repositoryId); else selected.delete(repositoryId); draft.peers[id]!.repositories = [...selected]; })} />{repository.name ?? repositoryId}</label>)}</fieldset>
      <p className="text-muted-foreground text-xs">Removing this host keeps its tasks recorded. They remain unreachable until the host is configured again.</p>
    </SettingsCard>)}
    <SettingsCard><Field label="New host ID" value={newHost} placeholder="workstation" onChange={setNewHost} /><Button variant="outline" onClick={add}>Add host</Button>{error && <p role="alert" className="text-destructive text-sm">{error}</p>}</SettingsCard>
  </SettingsSection>;
}
