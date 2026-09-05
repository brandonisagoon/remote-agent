import { Fragment } from "react";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";

/** Finder-style path bar pinned to the window footer on repository routes.
    Clicking a segment reveals that folder. */
export function RepositoryPathBar({ repositoryId }: { repositoryId: string }) {
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  if (!repository) return null;
  const segments = repository.root.replace(/\/$/, "").split("/").filter(Boolean);
  const pathTo = (index: number) => `/${segments.slice(0, index + 1).join("/")}`;
  return (
    <footer className="bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-1 overflow-hidden border-t px-3 text-[11px]">
      {segments.map((segment, index) => (
        <Fragment key={pathTo(index)}>
          {index > 0 && <F7Icon name="chevron_right" className="size-2.5 shrink-0 opacity-50" />}
          <button
            type="button"
            className="hover:text-foreground flex min-w-0 items-center gap-1 whitespace-nowrap"
            onClick={() => void window.remoteAgent.shell.openPath(pathTo(index))}
          >
            {index === segments.length - 1 && <F7Icon name="folder" className="size-3 shrink-0" />}
            <span className="truncate">{segment}</span>
          </button>
        </Fragment>
      ))}
    </footer>
  );
}
