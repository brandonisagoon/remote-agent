import { Fragment } from "react";
import { F7Icon, type F7IconName } from "@renderer/components/f7-icon.tsx";

/** Shared Finder-style footer for a checkout or a machine's config file. */
export function PathBar({ path, icon = "folder", onOpen }: { path: string; icon?: F7IconName; onOpen(path: string): void }) {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : "";
  const pathTo = (index: number) => `${prefix}${segments.slice(0, index + 1).join("/")}`;
  return (
    <footer aria-label="Path" className="bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-1 overflow-hidden border-t px-3 text-[11px]">
      {segments.map((segment, index) => (
        <Fragment key={pathTo(index)}>
          {index > 0 && <F7Icon name="chevron_right" className="size-2.5 shrink-0 opacity-50" />}
          <button
            type="button"
            title={pathTo(index)}
            className="hover:text-foreground flex min-w-0 items-center gap-1 whitespace-nowrap"
            onClick={() => onOpen(pathTo(index))}
          >
            {index === segments.length - 1 && <F7Icon name={icon} className="size-3 shrink-0" />}
            <span className="truncate">{segment}</span>
          </button>
        </Fragment>
      ))}
    </footer>
  );
}
