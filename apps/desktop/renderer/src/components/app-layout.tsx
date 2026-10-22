import { chooseHostRepository } from "./remote-path-picker.tsx";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";

import { useMachineActions } from "@renderer/pages/machine/use-machine-actions.ts";
import { AppSidebar } from "@renderer/components/app-sidebar.tsx";
import { InsetHeader } from "@renderer/components/inset-header.tsx";
import { KeyboardShortcuts } from "@renderer/components/keyboard-shortcuts.tsx";
import { RepositoryPathBar } from "@renderer/pages/repository/path-bar.tsx";
import { MachinePathBar } from "@renderer/pages/machine/path-bar.tsx";
import { cn } from "@renderer/lib/utils.ts";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarResizeHandle,
} from "@renderer/components/sidebar-resize-handle.tsx";
import { SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost, useHostDirectory } from "@renderer/lib/host-context.tsx";
import { randomHex } from "@renderer/lib/random.ts";

const SIDEBAR_WIDTH_STORAGE_KEY = "remote-agent:sidebar-width";

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
  const { host } = useHost();
  const { entries } = useHostDirectory();
  const search = { host: host.id };
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);

  // Adding a repository is a file pick, not a form: the ID is an opaque key,
  // the name comes from the folder, and everything else has editable defaults.
  const addRepository = async () => {
    const picked = await chooseHostRepository(host);
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
        worktreeNaming: { "*": "{branch}" },
      };
    };
    if (dirty) mutate(create);
    else void commit(create);
    void navigate({ to: "/repositories/$repositoryId", params: { repositoryId: id }, search });
  };

  const { addProvider, addConnection } = useMachineActions();

  // The macOS File menu mirrors the current machine's tab controls.
  useEffect(() =>
    window.remoteAgent.menu.onAction((payload) => {
      if (payload.action === "add-repository") void addRepository();
      else if (payload.action === "add-connection") addConnection();
      else addProvider(payload.providerId);
    }),
  );

  // Removal is confirmed by the sidebar's alert dialog; write through
  // directly unless draft edits are pending (same rule as creation).
  const applyRemoval = (hostId: string, remove: (value: typeof draft) => void, wasActive: boolean) => {
    const owner = entries.find((entry) => entry.host.id === hostId);
    if (!owner) return;
    void owner.config.commit(remove).catch((error) => toast.error(String(error)));
    if (wasActive && hostId === host.id) void navigate({ to: "/", search });
  };
  const params = useParams({ strict: false });
  const removeRepository = (hostId: string, id: string) => {
    applyRemoval(hostId, (value) => {
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
        onAddRepository={() => void addRepository()}
        onRemoveRepository={removeRepository}
      />

      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <InsetHeader />
        {/* The page scrolls in its own container so wheel events never chain
            into the sidebar (and vice versa). */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Sessions is a data table; let it use the full window width. */}
          <div
            className={cn(
              "mx-auto w-full",
              params.repositoryId && (params as { tab?: string }).tab === "sessions"
                ? // Full-bleed data view: gutters match the window header's px-4.
                  "max-w-none px-4 py-4"
                : "max-w-3xl px-8 py-8",
            )}
          >
            <Outlet key={host.id} />
          </div>
        </div>
        {params.repositoryId ? <RepositoryPathBar repositoryId={params.repositoryId} /> : <MachinePathBar />}
      </SidebarInset>

    </SidebarProvider>
  );
}
