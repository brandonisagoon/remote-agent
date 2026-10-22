import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ServiceFile } from "../../../../lib/config.ts";
import { useHost } from "@renderer/lib/host-context.tsx";
import { repoConfigsQueryOptions } from "@renderer/lib/queries/repo-configs.ts";
import { DraftToasts } from "@renderer/components/draft-toasts.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { ConfigProvider } from "@renderer/lib/config-context.tsx";
import { AppLayout } from "@renderer/components/app-layout.tsx";
import { HostRecoveryLayout, UnavailableHost } from "@renderer/components/host-recovery.tsx";
import { randomHex } from "@renderer/lib/random.ts";

/** Repairs invariants the schema allows but the UI assumes; returns whether
    anything changed. Currently: every connection owns exactly one webhook and
    is bound to the machine. */
function healConfig(value: ServiceFile): boolean {
  let changed = false;
  for (const connection of Object.values(value.connections)) {
    if (!connection.webhook) {
      connection.webhook = {
        slug: `wh-${randomHex(6)}`,
        secret: randomHex(16),
        webhookMaxAgeMs: 60_000,
      };
      changed = true;
    }
    if (connection.machineId === undefined) {
      connection.machineId = value.machine.id;
      changed = true;
    }
  }
  return changed;
}

export function App() {
  const { host, api, config, error, retry } = useHost();
  const { data: repoDocuments } = useQuery(repoConfigsQueryOptions(host.id));
  const { document, draft } = config;
  useEffect(() => { if (repoDocuments) config.receiveRepos(repoDocuments); }, [config, repoDocuments]);

  useEffect(() => {
    if (!document?.valid || config.dirty || config.saving) return;
    const healed = structuredClone(document.value);
    if (healConfig(healed)) void config.commit((value) => Object.assign(value, healed)).catch(() => {});
  }, [config, document]);

  const save = async () => {
    const repoDirty = Object.keys(config.repoDrafts).length > 0;
    try {
      await config.save();
      toast.success(repoDirty ? "Saved — commit .remote-agent.config.json in the repository" : "Configuration saved");
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  const commit = async (change: (value: ServiceFile) => void) => {
    try { await config.commit(change); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };

  if (!document && error) return <UnavailableHost error={String(error)} retry={retry} />;
  if (!document) return <HostRecoveryLayout><div className="grid h-full place-items-center"><F7Icon name="arrow_2_circlepath" className="animate-spin text-2xl" /></div></HostRecoveryLayout>;
  if (!document.valid || !draft) {
    return <HostRecoveryLayout><main className="bg-background grid min-h-screen place-items-center p-8">
      <div className="grid w-full max-w-2xl gap-4">
        <h1 className="text-lg font-semibold">Configuration needs attention</h1>
        <p className="text-muted-foreground text-sm">Fix the file in your editor. This window will update automatically.</p>
        <pre className="text-destructive bg-muted max-h-64 overflow-auto rounded-md p-4 text-xs">{document.valid ? "" : document.error}</pre>
        <div className="flex gap-2">
          <Button onClick={() => void api.config.openInEditor()}>Open in Code Editor</Button>
          <Button variant="outline" onClick={() => void api.config.reveal()}>Reveal in Finder</Button>
        </div>
      </div>
    </main></HostRecoveryLayout>;
  }
  return <ConfigProvider value={{ draft, mutate: config.mutate, repoConfig: config.repoConfig, save, commit, revert: config.revert, dirty: config.anyDirty }}>
    <DraftToasts key={host.id} externalChange={config.externalChange ?? (config.repoExternalChange ? config.adopted : null)} onReload={config.revert} />
    <AppLayout />
  </ConfigProvider>;
}
