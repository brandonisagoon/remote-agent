import { useQuery } from "@tanstack/react-query";

import { buildEditorDeepLink, sshLinkSupported } from "../../../../lib/machines/editor-link.ts";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { detectedEditorsQueryOptions } from "@renderer/lib/queries/editors.ts";

/** Dropdown of the editors detected on this machine, opening `target`.
    Scheme apps deep-link (SSH-capable via the machine's SSH host); AI apps
    without folder links open via `open -a`. */
export function OpenInEditorMenu({
  target,
  align = "end",
  compact = false,
}: {
  /** Absolute path to open. */
  target: string;
  align?: "start" | "end";
  /** size-6 trigger matching small toolbar icon buttons. */
  compact?: boolean;
}) {
  const { draft } = useConfig();
  const { data: editors = [] } = useQuery(detectedEditorsQueryOptions);
  const sshHost = draft.machine.sshHost ?? null;

  const openIn = (editor: { scheme: string | null; open: "scheme" | "app"; appPath: string }) => {
    if (editor.open === "app" || !editor.scheme) {
      void window.remoteAgent.shell.openWith(editor.appPath, target);
      return;
    }
    const remote = sshHost !== null && sshLinkSupported(editor.scheme);
    const link = buildEditorDeepLink(
      remote ? "ssh" : "local",
      editor.scheme,
      remote ? sshHost : null,
      target,
    );
    // Routed through the window-open handler to shell.openExternal.
    window.open(link);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={compact ? "h-6 gap-0.5 px-1" : "h-7 gap-1 px-1.5"}
            >
              <F7Icon
                name="chevron_left_slash_chevron_right"
                className={compact ? "size-3.5" : undefined}
              />
              <F7Icon name="chevron_down" className={compact ? "size-2 opacity-60" : "size-2.5 opacity-60"} />
              <span className="sr-only">Open in Editor</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Open in Editor</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align}>
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
  );
}
