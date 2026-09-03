import { useState } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";

import { AddRepositoryDialog } from "@renderer/components/add-repository-dialog.tsx";
import { AppSidebar } from "@renderer/components/app-sidebar.tsx";
import { InsetHeader } from "@renderer/components/inset-header.tsx";
import { KeyboardShortcuts } from "@renderer/components/keyboard-shortcuts.tsx";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarResizeHandle,
} from "@renderer/components/sidebar-resize-handle.tsx";
import { SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { randomHex } from "@renderer/lib/random.ts";

const SIDEBAR_WIDTH_STORAGE_KEY = "remote-agent:sidebar-width";

/** Opaque connection id: provider prefix for grep-ability + random hex. */
function generateConnectionId(): string {
  return `linear-${randomHex(6)}`;
}

function storedSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored < SIDEBAR_MIN_WIDTH || stored > SIDEBAR_MAX_WIDTH) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return stored;
}

export function AppLayout() {
  const { draft, mutate, commit, dirty } = useConfig();
  const navigate = useNavigate();
  const [addDialog, setAddDialog] = useState<"repository" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <KeyboardShortcuts />
      <SidebarResizeHandle
        onResize={setSidebarWidth}
        onCommit={(width) => localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))}
      />
      <AppSidebar
        value={draft}
        onAddProvider={(providerId) => {
          const create = (value: typeof draft) => {
            value.providers[providerId] = {};
          };
          if (dirty) mutate(create);
          else void commit(create);
          void navigate({ to: "/providers/$providerId", params: { providerId } });
        }}
        onAddConnection={() => {
          const id = generateConnectionId();
          const create = (value: typeof draft) => {
            value.connections[id] = {
              provider: "linear",
              name: "New Linear Connection",
              apiKey: "replace-me",
              agentUserId: "replace-me",
              router: { providerId: "codex", timeoutMs: 30_000 },
              editor: { name: "Zed", scheme: "zed", connection: "local" },
              webhook: {
                machineId: value.machine.id,
                slug: `wh-${randomHex(6)}`,
                secret: randomHex(16),
                webhookMaxAgeMs: 60_000,
                repositories: "*",
              },
            };
          };
          // A default connection is self-contained: write it through directly.
          // With unsaved edits pending it joins the draft instead, so those
          // are never silently saved along with it.
          if (dirty) mutate(create);
          else void commit(create);
          void navigate({ to: "/connections/$connectionId", params: { connectionId: id } });
        }}
        onAddRepository={() => setAddDialog("repository")}
      />

      <SidebarInset className="min-w-0">
        <InsetHeader />
        <div className="mx-auto w-full max-w-3xl px-8 py-8">
          <Outlet />
        </div>
      </SidebarInset>

      <AddRepositoryDialog
        open={addDialog === "repository"}
        onOpenChange={(open) => setAddDialog(open ? "repository" : null)}
        existingIds={Object.keys(draft.repositories)}
        onCreate={(id) => {
          mutate((value) => {
            value.repositories[id] = {
              name: "New Repository",
              root: `~/checkouts/${id}`,
              worktreeRoot: `~/.worktrees/${id}`,
              bootstrapCommand: ["true"],
              workflows: {
                describe: { prompt: "prompts/describe.md", provider: "claude" },
                orchestrate: { prompt: "prompts/orchestrate.md", provider: "codex" },
                reflect: { prompt: "prompts/reflect.md" },
              },
              metadata: { tags: {} },
              sessionDefaults: { tags: {} },
              triggers: {
                reflectOnState: "Pull Request",
                orchestrateOnState: "Planning",
                describeOnReaction: "pencil2",
              },
            };
          });
          void navigate({ to: "/repositories/$repositoryId", params: { repositoryId: id } });
        }}
      />
    </SidebarProvider>
  );
}
