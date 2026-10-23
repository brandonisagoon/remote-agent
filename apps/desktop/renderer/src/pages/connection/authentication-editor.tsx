import { useId, useRef } from "react";
import type { ServiceFile } from "../../../../../../lib/config.ts";
import type { LinearCredential } from "../../../../../../lib/linear-auth.ts";
import { Field } from "@renderer/components/field.tsx";
import { SecretField } from "@renderer/components/secret-field.tsx";
import type { Mutate } from "@renderer/lib/types.ts";

export function AuthenticationEditor({ connectionId, value, mutate }: { connectionId: string; value: ServiceFile; mutate: Mutate }) {
  const id = useId();
  const credential = value.connections[connectionId]!.apiKey;
  const app = typeof credential !== "string";
  // Preserve unsaved values when comparing the two authentication methods.
  const previous = useRef<LinearCredential>({ type: "app", clientId: "", clientSecret: "" });
  const update = (next: LinearCredential) => mutate((file) => { file.connections[connectionId]!.apiKey = next; });
  const key = typeof credential === "string" ? credential : typeof previous.current === "string" ? previous.current : "";
  const details = app ? credential : typeof previous.current !== "string" ? previous.current : { type: "app" as const, clientId: "", clientSecret: "" };
  return (
    <div className="grid gap-3">
      <label htmlFor={id} className="text-sm font-medium">Sign in as</label>
      <select id={id} className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={app ? "app" : "key"} onChange={(event) => {
        const next = event.target.value === "app" ? details : key;
        previous.current = credential;
        update(next);
      }}>
        <option value="key">Account using an API key</option>
        <option value="app">Linear app</option>
      </select>
      <div className={`grid transition-[grid-template-rows,opacity] duration-150 motion-reduce:transition-none ${app ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"}`} inert={app} aria-hidden={app}>
        <div className="min-h-0 overflow-hidden"><SecretField label="Linear API key" value={key} onChange={update} /></div>
      </div>
      <div className={`grid transition-[grid-template-rows,opacity] duration-150 motion-reduce:transition-none ${app ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`} inert={!app} aria-hidden={!app}>
        <div className="grid min-h-0 gap-3 overflow-hidden">
          <Field label="App client ID" value={details.clientId} onChange={(clientId) => update({ ...details, clientId })} />
          <SecretField label="App client secret" value={details.clientSecret} onChange={(clientSecret) => update({ ...details, clientSecret })} />
          <p className="text-muted-foreground text-xs">Enable client credentials in the app’s Linear settings. Updates appear as the app, and Remote Agent renews its access automatically.</p>
        </div>
      </div>
    </div>
  );
}
