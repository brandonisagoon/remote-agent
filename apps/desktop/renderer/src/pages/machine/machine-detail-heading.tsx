import { Link, useNavigate } from "@tanstack/react-router";
import { F7Icon } from "@renderer/components/f7-icon.tsx";
import { Button } from "@renderer/components/ui/button.tsx";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@renderer/components/ui/alert-dialog.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";

/** Keep list/detail navigation and removal inside the owning machine tab. */
export function MachineDetailHeading({ kind, id }: { kind: "provider" | "connection"; id: string }) {
  const { draft, commit } = useConfig();
  const { host } = useHost();
  const navigate = useNavigate();
  const providerId = id as keyof typeof draft.providers;
  const exists = kind === "provider" ? !!draft.providers[providerId] : !!draft.connections[id];
  const name = kind === "provider" ? PROVIDER_LABELS[id] ?? id : draft.connections[id]?.name ?? id;
  const to = kind === "provider" ? "/machine/providers" : "/machine/connections";
  const label = kind === "provider" ? "Providers" : "Connections";
  const action = kind === "provider" ? "Remove Provider" : "Delete Connection";
  const description = kind === "provider"
    ? "Sessions on this machine can no longer use this provider until it is added again."
    : "Its credentials and webhook endpoint will be removed from this machine.";
  const remove = () => {
    void commit((value) => {
      if (kind === "provider") delete value.providers[providerId];
      else delete value.connections[id];
    });
    void navigate({ to, search: { host: host.id } });
  };
  return (
    <div className="mb-6 flex min-w-0 items-center gap-2 text-sm">
      <Link to={to} search={{ host: host.id }} className="text-muted-foreground shrink-0 hover:text-foreground">{label}</Link>
      <F7Icon name="chevron_right" className="text-muted-foreground shrink-0" />
      <h1 className="min-w-0 truncate font-medium">{name}</h1>
      {exists && <AlertDialog>
        <Tooltip>
          <TooltipTrigger asChild><AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive ml-auto size-7 shrink-0">
              <F7Icon name="trash" /><span className="sr-only">{action}</span>
            </Button>
          </AlertDialogTrigger></TooltipTrigger>
          <TooltipContent>{action}</TooltipContent>
        </Tooltip>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name} from {host.name}?</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={remove}>Remove</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>}
    </div>
  );
}
