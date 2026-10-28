import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";

/** Shared Finder-style footer for the current location. */
export function PathBar({ children }: { children: ReactNode }) {
  const { host } = useHost();
  return (
    <footer aria-label="Path" className="bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-1 overflow-hidden border-t px-3 text-[11px]">
      <Link to="/machine" search={{ host: host.id }} title={host.name} className="hover:text-foreground flex max-w-48 shrink-0 items-center gap-1">
        <F7Icon name="desktopcomputer" className="size-3" />
        <span className="truncate">{host.name}</span>
      </Link>
      <PathBarSeparator />
      {children}
    </footer>
  );
}

export function PathBarSeparator() {
  return <F7Icon name="chevron_right" className="size-2.5 shrink-0 opacity-50" />;
}
