import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatForDisplay, parseHotkey } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";

import type { Keybindings } from "../../../shared.ts";
import { keybindingsQueryOptions } from "@renderer/lib/queries/keybindings.ts";

export type KeybindingAction =
  | "toggle-sidebar"
  | "back"
  | "forward"
  | "save"
  | "revert"
  | "toggle-secrets"
  | "prev-item"
  | "next-item"
  | "jump-item"
  | "add-repository";

/**
 * Mirrors DEFAULT_KEYBINDINGS in the main process (the seed for keybindings.json).
 * "jump-item" is a modifier prefix, not a full chord: the digit 1-9 of the
 * targeted sidebar item is appended (e.g. "Mod" -> Mod+1..Mod+9).
 */
export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  "toggle-sidebar": "Mod+B",
  "back": "Mod+[",
  "forward": "Mod+]",
  "save": "Mod+S",
  "revert": "Escape",
  "toggle-secrets": "Mod+Shift+.",
  "prev-item": "Mod+Alt+ArrowUp",
  "next-item": "Mod+Alt+ArrowDown",
  "jump-item": "Mod",
  "add-repository": "Mod+O",
};

export function jumpChord(bindings: Record<KeybindingAction, string>, ordinal: number): Hotkey {
  return `${bindings["jump-item"]}+${ordinal}` as Hotkey;
}

function merge(configured: Keybindings): Record<KeybindingAction, string> {
  const next = { ...DEFAULT_KEYBINDINGS };
  for (const action of Object.keys(next) as KeybindingAction[]) {
    const chord = configured[action];
    if (!chord) continue;
    try {
      // jump-item is a modifier prefix; validate it with a digit appended.
      parseHotkey(action === "jump-item" ? `${chord}+1` : chord);
      next[action] = chord;
    } catch {
      // Unparseable chord in keybindings.json: keep the default.
    }
  }
  return next;
}

const KeybindingsContext = createContext<Record<KeybindingAction, string>>(DEFAULT_KEYBINDINGS);

export function KeybindingsProvider({ children }: { children: React.ReactNode }) {
  const { data: configured } = useQuery(keybindingsQueryOptions);
  const bindings = useMemo(() => (configured ? merge(configured) : DEFAULT_KEYBINDINGS), [configured]);
  return <KeybindingsContext.Provider value={bindings}>{children}</KeybindingsContext.Provider>;
}

export function useKeybindings(): Record<KeybindingAction, string> {
  return useContext(KeybindingsContext);
}

/** Tooltip-ready form of an action's configured chord, e.g. "⌘ B" on macOS. */
export function useKeybindingLabel(action: KeybindingAction): string {
  return formatForDisplay(useKeybindings()[action]);
}
