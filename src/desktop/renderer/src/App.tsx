import { useEffect, useRef, useState } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ServiceFile } from "../../../lib/config.ts";
import type { ConfigDocument } from "../../../lib/config-file.ts";
import { DraftToasts } from "@renderer/components/draft-toasts.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { ConfigProvider } from "@renderer/lib/config-context.tsx";
import { randomHex } from "@renderer/lib/random.ts";
import { KeybindingsProvider } from "@renderer/lib/keybindings.tsx";
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
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<ServiceFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState<ConfigDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);

  // Adopt a document from disk; malformed-but-parseable configs are healed
  // and the correction written back immediately.
  const adopt = (next: ConfigDocument) => {
    setDocument(next);
    if (!next.valid) return;
    const healed = clone(next.value);
    if (!healConfig(healed)) {
      setDraft(clone(next.value));
      return;
    }
    setDraft(healed);
    void window.remoteAgent.config
      .save({ expectedRevision: next.revision, value: healed })
      .then((saved) => {
        setDocument(saved);
        if (saved.valid) setDraft(clone(saved.value));
      })
      .catch(() => setDirty(true));
  };

  useEffect(() => {
    void window.remoteAgent.config.get().then(adopt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    return window.remoteAgent.config.onChange((next) => {
      if (dirtyRef.current) {
        setExternalChange(next);
        return;
      }
      adopt(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Discard draft edits and re-adopt the file (the newest disk state if one
  // arrived while dirty). Flipping dirty off dismisses the toast.
  const revert = () => {
    const source = externalChange ?? document;
    if (!source?.valid) return;
    setDirty(false);
    setExternalChange(null);
    adopt(source);
  };

  const reloadExternalChange = () => {
    if (!externalChange) return;
    setDirty(false);
    setExternalChange(null);
    adopt(externalChange);
    toast("Reloaded changes from disk");
  };

  const mutate = (change: (value: ServiceFile) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = clone(current);
      change(next);
      return next;
    });
    setDirty(true);
  };

  // Apply a change and write it straight to disk, bypassing the dirty/toast
  // flow. Used for self-contained actions (e.g. creating a connection with
  // defaults). Falls back to a normal draft edit if the write fails.
  const commit = async (change: (value: ServiceFile) => void) => {
    if (!draft || !document) return;
    const next = clone(draft);
    change(next);
    setDraft(next);
    setSaving(true);
    try {
      const result = await window.remoteAgent.config.save({
        expectedRevision: document.revision,
        value: next,
      });
      setDocument(result);
      if (result.valid) setDraft(clone(result.value));
      setExternalChange(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setDirty(true);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!draft || !document || saving) return;
    setSaving(true);
    try {
      const next = await window.remoteAgent.config.save({
        expectedRevision: document.revision,
        value: draft,
      });
      setDocument(next);
      if (next.valid) setDraft(clone(next.value));
      setDirty(false);
      setExternalChange(null);
      toast.success("Configuration saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
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
            {document.error}
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
