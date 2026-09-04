import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";

import { AppSidebar } from "@renderer/components/app-sidebar.tsx";
import { InsetHeader } from "@renderer/components/inset-header.tsx";
import { KeyboardShortcuts } from "@renderer/components/keyboard-shortcuts.tsx";
import { RepositoryPathBar } from "@renderer/pages/repository/path-bar.tsx";
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
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);

  // Adding a repository is a file pick, not a form: the ID is an opaque key,
  // the name comes from the folder, and everything else has editable defaults.
  const addRepository = async () => {
    const picked = await window.remoteAgent.repository.pick();
    if (!picked) return;
    if ("error" in picked) {
      toast.error("That folder is not a git repository");
      return;
    }
    const id = `repo-${randomHex(6)}`;
    const create = (value: typeof draft) => {
      value.repositories[id] = {
        name: picked.repository.name,
        root: picked.repository.root,
        worktreeRoot: `../.worktrees/${picked.repository.name}`,
        bootstrapCommand: ["true"],
        skillsRoot: "agent-skills",
        workflows: {},
        labels: {},
        sessionDefaults: { labels: {} },
      };
    };
    if (dirty) mutate(create);
    else void commit(create);
    void navigate({ to: "/repositories/$repositoryId", params: { repositoryId: id } });
  };

  const addProvider = (providerId: "codex" | "claude") => {
    const create = (value: typeof draft) => {
      value.providers[providerId] = {};
    };
    if (dirty) mutate(create);
    else void commit(create);
    void navigate({ to: "/providers/$providerId", params: { providerId } });
  };
  const addConnection = () => {
    const id = generateConnectionId();
    const create = (value: typeof draft) => {
      value.connections[id] = {
        provider: "linear",
        name: "New Linear Connection",
        apiKey: "replace-me",
        agentUserId: "replace-me",
        machineId: value.machine.id,
        repositories: "*",
        router: { providerId: "codex", timeoutMs: 30_000 },
        editors: [{ name: "Zed", scheme: "zed" }],
        webhook: {
          slug: `wh-${randomHex(6)}`,
          secret: randomHex(16),
          webhookMaxAgeMs: 60_000,
        },
      };
    };
    // A default connection is self-contained: write it through directly.
    // With unsaved edits pending it joins the draft instead, so those are
    // never silently saved along with it.
    if (dirty) mutate(create);
    else void commit(create);
    void navigate({ to: "/connections/$connectionId", params: { connectionId: id } });
  };

  // The macOS File menu mirrors the sidebar's add controls.
  useEffect(() =>
    window.remoteAgent.menu.onAction((payload) => {
      if (payload.action === "add-repository") void addRepository();
      else if (payload.action === "add-connection") addConnection();
      else addProvider(payload.providerId);
    }),
  );

  // Removal is confirmed by the sidebar's alert dialog; write through
  // directly unless draft edits are pending (same rule as creation).
  const applyRemoval = (remove: (value: typeof draft) => void, wasActive: boolean) => {
    if (dirty) mutate(remove);
    else void commit(remove);
    if (wasActive) void navigate({ to: "/" });
  };
  const params = useParams({ strict: false });
  const removeProvider = (id: string) => {
    applyRemoval((value) => {
      delete value.providers[id as keyof typeof value.providers];
    }, params.providerId === id);
  };
  const removeConnection = (id: string) => {
    applyRemoval((value) => {
      delete value.connections[id];
    }, params.connectionId === id);
  };
  const removeRepository = (id: string) => {
    if (Object.keys(draft.repositories).length <= 1) {
      toast.error("At least one repository is required");
      return;
    }
    applyRemoval((value) => {
      delete value.repositories[id];
      // Heal connection allowlists that referenced it; an emptied allowlist
      // falls back to every repository.
      for (const connection of Object.values(value.connections)) {
        if (connection.repositories === "*") continue;
        delete connection.repositories[id];
        if (Object.keys(connection.repositories).length === 0) connection.repositories = "*";
      }
    }, params.repositoryId === id);
  };

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <KeyboardShortcuts onAddRepository={() => void addRepository()} />
      <SidebarResizeHandle
        onResize={setSidebarWidth}
        onCommit={(width) => localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))}
      />
      <AppSidebar
        value={draft}
        onAddProvider={addProvider}
        onAddConnection={addConnection}
        onAddRepository={() => void addRepository()}
        onRemoveProvider={removeProvider}
        onRemoveConnection={removeConnection}
        onRemoveRepository={removeRepository}
      />

      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <InsetHeader />
        {/* The page scrolls in its own container so wheel events never chain
            into the sidebar (and vice versa). */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-3xl px-8 py-8">
            <Outlet />
          </div>
        </div>
        {params.repositoryId && <RepositoryPathBar repositoryId={params.repositoryId} />}
      </SidebarInset>

    </SidebarProvider>
  );
}
