import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { PathBar, PathBarSeparator } from "@renderer/components/path-bar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";
import { PROVIDER_LABELS } from "@renderer/lib/sidebar-items.ts";
import { MachineDetailActions } from "./machine-detail-actions.tsx";

export function MachinePathBar() {
  const matchRoute = useMatchRoute();
  const { providerId, connectionId } = useParams({ strict: false });
  if (matchRoute({ to: "/machine/providers", fuzzy: true })) {
    return <MachineTabPathBar kind="provider" id={providerId} />;
  }
  if (matchRoute({ to: "/machine/connections", fuzzy: true })) {
    return <MachineTabPathBar kind="connection" id={connectionId} />;
  }
  if (matchRoute({ to: "/machine/server" })) {
    return <PathBar><span aria-current="page">Server</span></PathBar>;
  }
  return null;
}

function MachineTabPathBar({ kind, id }: { kind: "provider" | "connection"; id?: string }) {
  const { draft } = useConfig();
  const { host } = useHost();
  const to = kind === "provider" ? "/machine/providers" : "/machine/connections";
  const label = kind === "provider" ? "Providers" : "Connections";
  if (!id) return <PathBar><span aria-current="page">{label}</span></PathBar>;
  const name = kind === "provider" ? PROVIDER_LABELS[id] ?? id : draft.connections[id]?.name ?? id;
  return (
    <PathBar>
      <nav aria-label="Machine path" className="flex min-w-0 items-center gap-1">
        <Link to={to} search={{ host: host.id }} className="hover:text-foreground shrink-0">{label}</Link>
        <PathBarSeparator />
        <span aria-current="page" title={name} className="text-foreground truncate">{name}</span>
      </nav>
      <MachineDetailActions kind={kind} id={id} />
    </PathBar>
  );
}
