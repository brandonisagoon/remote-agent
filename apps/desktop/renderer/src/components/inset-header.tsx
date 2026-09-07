import { useParams } from "@tanstack/react-router";

import { DeleteConnectionButton } from "@renderer/components/delete-connection-button.tsx";
import { RepositoryHeaderControls } from "@renderer/pages/repository/repository-header-controls.tsx";
import { NavHistoryButtons } from "@renderer/components/nav-history-buttons.tsx";
import { SidebarTrigger, useSidebar } from "@renderer/components/ui/sidebar.tsx";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import { useKeybindingLabel } from "@renderer/lib/keybindings.tsx";
import { cn } from "@renderer/lib/utils.ts";

function useHeaderTitle(): string {
  const { draft } = useConfig();
  const params = useParams({ strict: false });
  if (params.providerId) return PROVIDER_LABELS[params.providerId] ?? params.providerId;
  if (params.connectionId) return draft.connections[params.connectionId]?.name ?? params.connectionId;
  if (params.repositoryId) return draft.repositories[params.repositoryId]?.name ?? params.repositoryId;
  return draft.machine.name;
}

export function InsetHeader() {
  const { open, isMobile } = useSidebar();
  const title = useHeaderTitle();
  const params = useParams({ strict: false });
  const toggleLabel = useKeybindingLabel("toggle-sidebar");
  return (
    <header className="titlebar-drag bg-background sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b px-4">
      {/* When the sidebar is hidden the trigger clears the traffic lights and the
          history buttons relocate here from the hidden sidebar header. */}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Closed: clear the native traffic-light cluster (ends ~80pt; 16px
              header padding + 72px = button edge at 88). */}
          <SidebarTrigger className={cn(!open || isMobile ? "ml-[80px]" : "-ml-1")} />
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          Toggle Sidebar{" "}
          <KbdGroup>
            {toggleLabel.split(" ").map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      {(!open || isMobile) && <NavHistoryButtons />}
      <span className="truncate text-sm font-medium">{title}</span>
      {params.repositoryId && <RepositoryHeaderControls repositoryId={params.repositoryId} />}
      {params.connectionId && <DeleteConnectionButton id={params.connectionId} className="ml-auto" />}
    </header>
  );
}
