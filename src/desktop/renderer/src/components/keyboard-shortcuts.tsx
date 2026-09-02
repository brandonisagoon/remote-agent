import { useHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { useSidebar } from "@renderer/components/ui/sidebar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { jumpChord, useKeybindings } from "@renderer/lib/keybindings.tsx";
import { toggleAllSecrets } from "@renderer/lib/secrets-visibility.ts";
import { navigateToItem, useCurrentSidebarIndex, useSidebarItems } from "@renderer/lib/sidebar-items.ts";

/**
 * Binds the configured keybindings.json chords to app actions. Rendered once
 * inside the layout (needs the sidebar and router contexts). preventDefault
 * matters: Electron otherwise handles Mod+[ / Mod+] as webContents history.
 */
export function KeyboardShortcuts() {
  const bindings = useKeybindings();
  const { history } = useRouter();
  const { toggleSidebar } = useSidebar();
  const { save, revert, dirty } = useConfig();

  const navigate = useNavigate();
  const items = useSidebarItems();
  const currentIndex = useCurrentSidebarIndex(items);

  useHotkey(bindings["back"] as Hotkey, () => history.back(), { preventDefault: true });
  useHotkey(bindings["forward"] as Hotkey, () => history.forward(), { preventDefault: true });
  useHotkey(bindings["toggle-sidebar"] as Hotkey, () => toggleSidebar(), { preventDefault: true });
  useHotkey(bindings["save"] as Hotkey, () => void save(), { preventDefault: true });
  // No preventDefault: Radix overlays also listen for Escape to close.
  useHotkey(bindings["revert"] as Hotkey, () => revert(), { enabled: dirty });
  useHotkey(bindings["toggle-secrets"] as Hotkey, () => toggleAllSecrets(), { preventDefault: true });
  useHotkey(
    bindings["prev-item"] as Hotkey,
    () => {
      const target = items[currentIndex <= 0 ? 0 : currentIndex - 1];
      if (target) navigateToItem(navigate, target);
    },
    { preventDefault: true },
  );
  useHotkey(
    bindings["next-item"] as Hotkey,
    () => {
      const target = items[Math.min(items.length - 1, currentIndex + 1)];
      if (target) navigateToItem(navigate, target);
    },
    { preventDefault: true },
  );
  // jump-item prefix + 1..9 jumps to the nth sidebar item (badges shown while the prefix is held).
  useHotkeys(
    items.slice(0, 9).map((item, index) => ({
      hotkey: jumpChord(bindings, index + 1),
      callback: () => navigateToItem(navigate, item),
      options: { preventDefault: true },
    })),
  );

  return null;
}
