import type { ReactNode } from "react";
import { F7Icon } from "@renderer/components/f7-icon.tsx";

/** Shared Finder-style footer for the current location. */
export function PathBar({ children }: { children: ReactNode }) {
  return (
    <footer aria-label="Path" className="bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-1 overflow-hidden border-t px-3 text-[11px]">
      {children}
    </footer>
  );
}

export function PathBarSeparator() {
  return <F7Icon name="chevron_right" className="size-2.5 shrink-0 opacity-50" />;
}
