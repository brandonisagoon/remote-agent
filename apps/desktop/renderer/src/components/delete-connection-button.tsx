import { useNavigate } from "@tanstack/react-router";

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
  AlertDialogTrigger,
} from "@renderer/components/ui/alert-dialog.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { cn } from "@renderer/lib/utils.ts";

export function DeleteConnectionButton({ id, className }: { id: string; className?: string }) {
  const { draft, mutate, commit, dirty } = useConfig();
  const navigate = useNavigate();
  const connection = draft.connections[id];
  if (!connection) return null;
  const deleteConnection = () => {
    const remove = (file: typeof draft) => {
      delete file.connections[id];
    };
    // The AlertDialog is the confirmation; write through directly. With
    // unsaved edits pending it joins the draft instead, so those are never
    // silently saved along with it.
    if (dirty) mutate(remove);
    else void commit(remove);
    void navigate({ to: "/" });
  };
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("text-muted-foreground hover:text-destructive size-7", className)}
            >
              <F7Icon name="trash" />
              <span className="sr-only">Delete Connection</span>
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete Connection</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {connection.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {connection.webhook
              ? "Its credentials and webhook endpoint will be removed."
              : "Its credentials will be removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={deleteConnection}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
