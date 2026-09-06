import { useCallback, useEffect, useRef, useState } from "react";

import { useSidebar } from "@renderer/components/ui/sidebar.tsx";
import { cn } from "@renderer/lib/utils.ts";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 256;

/**
 * Drag handle on the sidebar's right edge that resizes it by driving the
 * provider's --sidebar-width variable. The shadcn Resizable component
 * (react-resizable-panels) is not used because the Sidebar is fixed-positioned
 * with an offcanvas collapse — panels would fight its layout model.
 */
export function SidebarResizeHandle({
  onResize,
  onCommit,
}: {
  onResize(width: number): void;
  onCommit(width: number): void;
}) {
  const { open, isMobile } = useSidebar();
  const [dragging, setDragging] = useState(false);
  const latestWidth = useRef(SIDEBAR_DEFAULT_WIDTH);

  const clamp = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      latestWidth.current = clamp(event.clientX);
      onResize(latestWidth.current);
    },
    [dragging, onResize],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
      onCommit(latestWidth.current);
    },
    [dragging, onCommit],
  );

  // Kill the sidebar's width transition and text selection while dragging so
  // it tracks the pointer 1:1.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-sidebar-resizing", dragging);
    return () => document.documentElement.removeAttribute("data-sidebar-resizing");
  }, [dragging]);

  if (!open || isMobile) return null;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "fixed inset-y-0 z-20 w-2 cursor-col-resize",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
        dragging ? "after:bg-ring" : "hover:after:bg-border",
      )}
      style={{ left: "calc(var(--sidebar-width) - 4px)" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => {
        onResize(SIDEBAR_DEFAULT_WIDTH);
        onCommit(SIDEBAR_DEFAULT_WIDTH);
      }}
    />
  );
}
