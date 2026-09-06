import { useState } from "react";

import { F7Icon } from "@renderer/components/f7-icon.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu.tsx";

/** Right-click Remove for a sidebar row, confirmed by an alert dialog. */
export function RemovableSidebarItem(props: {
  label: string;
  description: string;
  onRemove(): void;
  children: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{props.children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <F7Icon name="xmark" />
            Remove
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {props.label}?</AlertDialogTitle>
            <AlertDialogDescription>{props.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={props.onRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
