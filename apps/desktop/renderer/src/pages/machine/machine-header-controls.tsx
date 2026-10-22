import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";

const TABS = [
  { to: "/machine/server", label: "Server" },
  { to: "/machine/providers", label: "Providers" },
  { to: "/machine/connections", label: "Connections" },
] as const;

export function MachineHeaderControls() {
  const { host } = useHost();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const active = TABS.find(({ to }) => matchRoute({ to, fuzzy: true })) ?? TABS[0];
  return (
    <Tabs
      value={active.to}
      onValueChange={(next) => {
        const tab = TABS.find(({ to }) => to === next);
        if (tab) void navigate({ to: tab.to, search: { host: host.id } });
      }}
      className="ml-auto shrink-0"
    >
      <TabsList aria-label="Machine settings">
        {TABS.map(({ to, label }) => <TabsTrigger key={to} value={to}>{label}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  );
}
