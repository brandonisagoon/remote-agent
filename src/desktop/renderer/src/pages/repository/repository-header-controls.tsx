import { useQuery } from "@tanstack/react-query";

import { buildEditorDeepLink, sshLinkSupported } from "../../../../../lib/machines/editor-link.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { detectedEditorsQueryOptions } from "@renderer/lib/queries/editors.ts";
import {
  setRepositoryTab,
  useRepositoryTab,
  type RepositoryTab,
} from "./tab-store.ts";

const TABS: Array<{ id: RepositoryTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
  { id: "skillsets", label: "Skillsets" },
];

/** Header widgets for repository routes: the page tabs and an Open in Editor
    dropdown listing every configured editor. */
export function RepositoryHeaderControls({ repositoryId }: { repositoryId: string }) {
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  const tab = useRepositoryTab(repositoryId);
  // Installed editor apps (icons included), detected by the main process.
  const { data: editors = [] } = useQuery(detectedEditorsQueryOptions);
  if (!repository) return null;

  const sshHost = draft.machine.sshHost ?? null;

  const openIn = (editor: { scheme: string | null; open: "scheme" | "app"; appPath: string }) => {
    if (editor.open === "app" || !editor.scheme) {
      // No folder deep link (AI apps like ChatGPT/Claude/bb): open-with.
      void window.remoteAgent.shell.openWith(editor.appPath, repository.root);
      return;
    }
    const remote = sshHost !== null && sshLinkSupported(editor.scheme);
    const link = buildEditorDeepLink(
      remote ? "ssh" : "local",
      editor.scheme,
      remote ? sshHost : null,
      repository.root,
    );
    // Routed through the window-open handler to shell.openExternal.
    window.open(link);
  };

  return (
    <>
      {/* Absolutely centered in the header so left/right widgets don't shift it. */}
      <Tabs
        value={tab}
        onValueChange={(next) => setRepositoryTab(repositoryId, next as RepositoryTab)}
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
      {editors.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-1.5">
                  <F7Icon name="chevron_left_slash_chevron_right" />
                  <F7Icon name="chevron_down" className="size-2.5 opacity-60" />
                  <span className="sr-only">Open in Editor</span>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Open in Editor</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {editors.map((editor) => (
              <DropdownMenuItem key={editor.scheme ?? editor.appPath} onSelect={() => openIn(editor)}>
                {editor.icon ? (
                  <img src={editor.icon} alt="" className="size-4.5" />
                ) : (
                  <F7Icon name="chevron_left_slash_chevron_right" className="size-4" />
                )}
                {editor.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
