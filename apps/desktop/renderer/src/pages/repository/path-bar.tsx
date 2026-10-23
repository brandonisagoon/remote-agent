import { Fragment } from "react";
import { useHost } from "@renderer/lib/host-context.tsx";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { PathBar, PathBarSeparator } from "@renderer/components/path-bar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";

/** Finder-style path bar pinned to the window footer on repository routes.
    Clicking a segment reveals that folder. */
export function RepositoryPathBar({ repositoryId }: { repositoryId: string }) {
  const { api } = useHost();
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  if (!repository) return null;
  const normalized = repository.root.replaceAll("\\", "/").replace(/\/$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : "";
  const pathTo = (index: number) => `${prefix}${segments.slice(0, index + 1).join("/")}`;
  return (
    <PathBar>
      {segments.map((segment, index) => (
        <Fragment key={pathTo(index)}>
          {index > 0 && <PathBarSeparator />}
          <button
            type="button"
            title={pathTo(index)}
            className="hover:text-foreground flex min-w-0 items-center gap-1 whitespace-nowrap"
            onClick={() => void api.shell.openPath(pathTo(index))}
          >
            {index === segments.length - 1 && <F7Icon name="folder" className="size-3 shrink-0" />}
            <span className="truncate">{segment}</span>
          </button>
        </Fragment>
      ))}
    </PathBar>
  );
}
