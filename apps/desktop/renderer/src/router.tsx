import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  Navigate,
} from "@tanstack/react-router";

import { App } from "./app-root.tsx";
import { HostProvider, useHost } from "@renderer/lib/host-context.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { ConnectionPage } from "@renderer/pages/connection/connection-page.tsx";
import { ProviderPage } from "@renderer/pages/provider/provider-page.tsx";
import { MachinePage } from "@renderer/pages/machine/machine-page.tsx";
import { ProvidersTab } from "@renderer/pages/machine/providers-tab.tsx";
import { ConnectionsTab } from "@renderer/pages/machine/connections-tab.tsx";
import { MachineDetailHeading } from "@renderer/pages/machine/machine-detail-heading.tsx";
import { RepositoryPage } from "@renderer/pages/repository/repository-page.tsx";

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { host?: string } => ({
    host: typeof search.host === "string" ? search.host : undefined,
  }),
  component: () => <HostProvider><App /></HostProvider>,
  notFoundComponent: () => <PageHeading title="Not found" description="This location does not exist." />,
});

const machineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machine",
});

const machineIndexRoute = createRoute({
  getParentRoute: () => machineRoute,
  path: "/",
  beforeLoad: ({ search }) => { throw redirect({ to: "/machine/server", search }); },
});

const machineServerRoute = createRoute({
  getParentRoute: () => machineRoute,
  path: "server",
  component: function Machine() {
    const { draft, mutate } = useConfig();
    return <MachinePage value={draft} mutate={mutate} />;
  },
});

// Config loading is handled by App so an offline default host cannot block the directory.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Index() {
    const { draft } = useConfig();
    const { host } = useHost();
    const repositoryId = Object.keys(draft.repositories)[0];
    if (repositoryId) return <Navigate to="/repositories/$repositoryId" params={{ repositoryId }} search={{ host: host.id }} replace />;
    return <Navigate to="/machine" search={{ host: host.id }} replace />;
  },
});

const providerRoute = createRoute({
  getParentRoute: () => machineRoute,
  path: "providers/$providerId",
  component: function Provider() {
    const { providerId } = providerRoute.useParams();
    const { draft, mutate } = useConfig();
    return <><MachineDetailHeading kind="provider" id={providerId} /><ProviderPage id={providerId} value={draft} mutate={mutate} /></>;
  },
});

const connectionRoute = createRoute({
  getParentRoute: () => machineRoute,
  path: "connections/$connectionId",
  component: function Connection() {
    const { connectionId } = connectionRoute.useParams();
    const { draft, mutate } = useConfig();
    return <><MachineDetailHeading kind="connection" id={connectionId} /><ConnectionPage id={connectionId} value={draft} mutate={mutate} /></>;
  },
});

const providersRoute = createRoute({ getParentRoute: () => machineRoute, path: "providers", component: ProvidersTab });
const connectionsRoute = createRoute({ getParentRoute: () => machineRoute, path: "connections", component: ConnectionsTab });

// Previously saved links still reach the same configuration on the same host.
const legacyProviderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerId",
  beforeLoad: ({ params, search }) => { throw redirect({ to: "/machine/providers/$providerId", params, search }); },
});
const legacyConnectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections/$connectionId",
  beforeLoad: ({ params, search }) => { throw redirect({ to: "/machine/connections/$connectionId", params, search }); },
});

const REPOSITORY_TABS = ["sessions", "settings", "skillsets"] as const;
export type RepositoryTab = (typeof REPOSITORY_TABS)[number];

/** Sidebar links are bare (/repositories/:id); land on the tab the user
    last used for that repository rather than resetting to Sessions. */
function lastRepositoryTab(hostId: string, repositoryId: string): RepositoryTab {
  const stored = localStorage.getItem(`repository-tab:${hostId}:${repositoryId}`);
  return REPOSITORY_TABS.includes(stored as RepositoryTab) ? (stored as RepositoryTab) : "sessions";
}

function rememberRepositoryTab(hostId: string, repositoryId: string, tab: RepositoryTab): void {
  localStorage.setItem(`repository-tab:${hostId}:${repositoryId}`, tab);
}

const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repositories/$repositoryId",
});

// Bare repository links land on the repository's last-used tab.
const repositoryIndexRoute = createRoute({
  getParentRoute: () => repositoryRoute,
  path: "/",
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/repositories/$repositoryId/$tab",
      params: { repositoryId: params.repositoryId, tab: lastRepositoryTab(search.host ?? "", params.repositoryId) },
      search,
    });
  },
});

const repositoryTabRoute = createRoute({
  getParentRoute: () => repositoryRoute,
  path: "$tab",
  beforeLoad: ({ params, search }) => {
    if (!REPOSITORY_TABS.includes(params.tab as RepositoryTab)) {
      throw redirect({
        to: "/repositories/$repositoryId/$tab",
        params: { repositoryId: params.repositoryId, tab: "sessions" },
        search,
      });
    }
  },
  component: function Repository() {
    const { repositoryId, tab } = repositoryTabRoute.useParams();
    const { draft, mutate } = useConfig();
    const { host } = repositoryTabRoute.useSearch();
    rememberRepositoryTab(host ?? "", repositoryId, tab as RepositoryTab);
    return (
      <RepositoryPage
        id={repositoryId}
        tab={tab as RepositoryTab}
        value={draft}
        mutate={mutate}
      />
    );
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  machineRoute.addChildren([machineIndexRoute, machineServerRoute, providersRoute, providerRoute, connectionsRoute, connectionRoute]),
  legacyProviderRoute,
  legacyConnectionRoute,
  repositoryRoute.addChildren([repositoryIndexRoute, repositoryTabRoute]),
]);

// Hash history: works under the file:// URL of a packaged Electron build.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
