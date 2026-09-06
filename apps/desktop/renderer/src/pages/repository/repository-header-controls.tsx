import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";

import { useConfig } from "@renderer/lib/config-context.tsx";
import { sessionsQueryOptions } from "@renderer/lib/queries/sessions.ts";
import { cn } from "@renderer/lib/utils.ts";
import type { RepositoryTab } from "@renderer/router.tsx";

const TABS: Array<{ id: RepositoryTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
  { id: "skillsets", label: "Skillsets" },
];

/** Header widgets for repository routes: the page tabs and an Open in Editor
    dropdown listing every detected editor app. */
export function RepositoryHeaderControls({ repositoryId }: { repositoryId: string }) {
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { tab?: string };
  const tab = (params.tab as RepositoryTab | undefined) ?? "sessions";
  const queryClient = useQueryClient();
  const sessionsKey = sessionsQueryOptions(repositoryId).queryKey;
  const refreshing = useIsFetching({ queryKey: sessionsKey }) > 0;
  if (!repository) return null;

  return (
    <>
      {/* Absolutely centered in the header so left/right widgets don't shift it. */}
      <Tabs
        value={tab}
        onValueChange={(next) =>
          void navigate({
            to: "/repositories/$repositoryId/$tab",
            params: { repositoryId, tab: next as RepositoryTab },
          })
        }
        className="absolute left-1/2 -translate-x-1/2"
      >
        <TabsList>
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <span className="ml-auto flex items-center gap-0.5">
        {tab === "sessions" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => void queryClient.invalidateQueries({ queryKey: sessionsKey })}
              >
                <F7Icon name="arrow_2_circlepath" className={cn(refreshing && "animate-spin")} />
                <span className="sr-only">Refresh Sessions</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh Sessions</TooltipContent>
          </Tooltip>
        )}
        <OpenInEditorMenu target={repository.root} />
      </span>
    </>
  );
}
