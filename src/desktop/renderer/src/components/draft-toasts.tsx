import { useEffect } from "react";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { toast } from "sonner";

import type { ConfigDocument } from "../../../../lib/config-file.ts";
import { Button } from "@renderer/components/ui/button.tsx";
import { Kbd, KbdGroup } from "@renderer/components/ui/kbd.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useKeybindings } from "@renderer/lib/keybindings.tsx";

function ButtonKbds({ chord, onDark }: { chord: string; onDark?: boolean }) {
  return (
    <KbdGroup>
      {formatForDisplay(chord).split(" ").map((key) => (
        <Kbd
          key={key}
          className={
            onDark
              ? "bg-primary-foreground/20 text-primary-foreground h-4 min-w-4 rounded-[4px] px-1 text-[10px]"
              : "h-4 min-w-4 rounded-[4px] px-1 text-[10px]"
          }
        >
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

/** Owns the unsaved-changes and changed-on-disk toasts (needs the keybindings context). */
export function DraftToasts({
  externalChange,
  onReload,
}: {
  externalChange: ConfigDocument | null;
  onReload(): void;
}) {
  const { dirty, save, revert } = useConfig();
  const bindings = useKeybindings();

  useEffect(() => {
    if (!dirty) {
      toast.dismiss("unsaved");
      return;
    }
    toast("Unsaved changes", {
      id: "unsaved",
      duration: Infinity,
      action: (
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={revert}>
            Revert <ButtonKbds chord={bindings["revert"]} />
          </Button>
          <Button size="sm" onClick={() => void save()}>
            Save <ButtonKbds chord={bindings["save"]} onDark />
          </Button>
        </div>
      ),
    });
  });

  useEffect(() => {
    if (!externalChange) {
      toast.dismiss("external-change");
      return;
    }
    toast("Config changed on disk", {
      id: "external-change",
      duration: Infinity,
      action: (
        <Button size="sm" variant="outline" className="ml-auto" onClick={onReload}>
          Reload
        </Button>
      ),
    });
  });

  return null;
}
