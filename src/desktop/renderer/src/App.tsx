import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ServiceFile } from "../../../lib/config.ts";
import type { ConfigDocument } from "../../../lib/config-file.ts";
import { DraftToasts } from "@renderer/components/draft-toasts.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { ConfigProvider } from "@renderer/lib/config-context.tsx";
import { KeybindingsProvider } from "@renderer/lib/keybindings.tsx";
import { configQueryOptions, useSaveConfig } from "@renderer/lib/queries/config.ts";
import { randomHex } from "@renderer/lib/random.ts";
import { router } from "@renderer/router.tsx";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Repairs invariants the schema allows but the UI assumes; returns whether
    anything changed. Currently: every connection owns exactly one webhook. */
function healConfig(value: ServiceFile): boolean {
  let changed = false;
  for (const connection of Object.values(value.connections)) {
    if (!connection.webhook) {
      connection.webhook = {
        machineId: value.machine.id,
        slug: `wh-${randomHex(6)}`,
        secret: randomHex(16),
        webhookMaxAgeMs: 60_000,
        repositories: "*",
      };
      changed = true;
    }
  }
  return changed;
}

export function App() {
  // The query holds disk truth (push-updated by the file watcher). The draft
  // is form state layered on top: it remembers the document it was adopted
  // from and only converges on disk changes while clean.
  const { data: document } = useQuery(configQueryOptions);
  const saveConfig = useSaveConfig();
  const [adopted, setAdopted] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<ServiceFile | null>(null);
  const [dirty, setDirty] = useState(false);

  // Adopt disk truth whenever clean; heal corrections write straight back out.
  useEffect(() => {
    if (!document || dirty) return;
    if (adopted?.revision === document.revision) return;
    setAdopted(document);
    if (!document.valid) {
      setDraft(null);
      return;
    }
    const healed = clone(document.value);
    if (!healConfig(healed)) {
      setDraft(clone(document.value));
      return;
    }
    setDraft(healed);
    saveConfig
      .mutateAsync({ expectedRevision: document.revision, value: healed })
      .then((saved) => setAdopted(saved))
      .catch(() => setDirty(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, dirty, adopted]);

  // Disk moved past the document the draft is based on while dirty.
  const externalChange =
    dirty && document && adopted && document.revision !== adopted.revision ? document : null;

  const mutate = (change: (value: ServiceFile) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = clone(current);
      change(next);
      return next;
    });
    setDirty(true);
  };

  const adopt = (next: ConfigDocument) => {
    setDirty(false);
    setAdopted(next);
    setDraft(next.valid ? clone(next.value) : null);
  };

  const save = async () => {
    if (!draft || !adopted || saveConfig.isPending) return;
    try {
      const next = await saveConfig.mutateAsync({
        expectedRevision: adopted.revision,
        value: draft,
      });
      adopt(next);
      toast.success("Configuration saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // Apply a change and write it straight to disk, bypassing the dirty/toast
  // flow. Used for self-contained actions (e.g. creating a connection with
  // defaults). Falls back to a normal draft edit if the write fails.
  const commit = async (change: (value: ServiceFile) => void) => {
    if (!draft || !adopted) return;
    const next = clone(draft);
    change(next);
    setDraft(next);
    try {
      const saved = await saveConfig.mutateAsync({
        expectedRevision: adopted.revision,
        value: next,
      });
      adopt(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setDirty(true);
    }
  };

  // Discard draft edits and re-adopt disk truth (the newest, if it moved).
  const revert = () => {
    const source = externalChange ?? adopted;
    if (!source?.valid) return;
    adopt(source);
  };

  const reloadExternalChange = () => {
    if (!externalChange) return;
    adopt(externalChange);
    toast("Reloaded changes from disk");
  };

  if (!document) {
    return (
      <div className="bg-background grid h-screen place-items-center">
        <F7Icon name="arrow_2_circlepath" className="animate-spin text-2xl" />
      </div>
    );
  }

  if (!document.valid || !draft) {
    return (
      <main className="bg-background grid h-screen place-items-center p-8">
        <div className="grid w-full max-w-2xl gap-4">
          <div className="flex items-center gap-2">
            <F7Icon name="exclamationmark_circle" className="text-destructive text-[20px]" />
            <h1 className="text-lg font-semibold">Configuration needs attention</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            The file was not overwritten. Fix it in your editor and this window will update automatically.
          </p>
          <pre className="text-destructive bg-muted max-h-64 overflow-auto rounded-md p-4 text-xs">
            {document.valid ? "" : document.error}
          </pre>
          <div className="flex gap-2">
            <Button onClick={() => void window.remoteAgent.config.openInEditor()}>
              <F7Icon name="chevron_left_slash_chevron_right" />
              Open in Code Editor
            </Button>
            <Button variant="outline" onClick={() => void window.remoteAgent.config.reveal()}>
              <F7Icon name="arrow_up_right_square" />
              Reveal in Finder
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <KeybindingsProvider>
      <ConfigProvider value={{ draft, mutate, save, commit, revert, dirty }}>
        <DraftToasts externalChange={externalChange} onReload={reloadExternalChange} />
        <RouterProvider router={router} />
      </ConfigProvider>
    </KeybindingsProvider>
  );
}
