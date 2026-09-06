import { useSyncExternalStore } from "react";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { ButtonGroup } from "@renderer/components/ui/button-group.tsx";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useKeybindingLabel } from "@renderer/lib/keybindings.tsx";

function historyIndex(history: RouterHistory): number {
  return (history.location.state as { __TSR_index?: number }).__TSR_index ?? 0;
}

/**
 * The router exposes canGoBack but not canGoForward, so track the history's
 * entry index: a PUSH truncates the forward stack, everything else
 * (back/forward/replace) preserves it. One shared tracker per history —
 * this component mounts in two places (sidebar header and, when the sidebar
 * is hidden, the page header), and per-instance state would reset on mount.
 */
interface ForwardTracker {
  maxIndex: number;
  listeners: Set<() => void>;
}
const trackers = new WeakMap<RouterHistory, ForwardTracker>();

function getTracker(history: RouterHistory): ForwardTracker {
  let tracker = trackers.get(history);
  if (!tracker) {
    const created: ForwardTracker = { maxIndex: historyIndex(history), listeners: new Set() };
    history.subscribe(({ action }) => {
      const current = historyIndex(history);
      created.maxIndex = action.type === "PUSH" ? current : Math.max(created.maxIndex, current);
      created.listeners.forEach((listener) => listener());
    });
    trackers.set(history, created);
    tracker = created;
  }
  return tracker;
}

function useCanGoForward(): boolean {
  const { history } = useRouter();
  const tracker = getTracker(history);
  return useSyncExternalStore(
    (onChange) => {
      tracker.listeners.add(onChange);
      return () => tracker.listeners.delete(onChange);
    },
    () => historyIndex(history) < tracker.maxIndex,
  );
}

export function NavHistoryButtons({ className }: { className?: string }) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const canGoForward = useCanGoForward();
  const backLabel = useKeybindingLabel("back");
  const forwardLabel = useKeybindingLabel("forward");
  return (
    <ButtonGroup aria-label="History" className={className}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled instead of disabled: keeps pointer events so the
              tooltip still opens while the action is unavailable. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 aria-disabled:opacity-50"
            aria-disabled={!canGoBack}
            onClick={() => canGoBack && router.history.back()}
          >
            <F7Icon name="chevron_left" />
            <span className="sr-only">Back</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          Back{" "}
          <KbdGroup>
            {backLabel.split(" ").map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 aria-disabled:opacity-50"
            aria-disabled={!canGoForward}
            onClick={() => canGoForward && router.history.forward()}
          >
            <F7Icon name="chevron_right" />
            <span className="sr-only">Forward</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          Forward{" "}
          <KbdGroup>
            {forwardLabel.split(" ").map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </ButtonGroup>
  );
}
