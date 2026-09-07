import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";

import { AppLayout } from "@renderer/components/app-layout.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { configQueryOptions } from "@renderer/lib/queries/config.ts";
import { queryClient } from "@renderer/lib/queries/query-client.ts";
import { ConnectionPage } from "@renderer/pages/connection/connection-page.tsx";
import { ProviderPage } from "@renderer/pages/provider/provider-page.tsx";
import { MachinePage } from "@renderer/pages/machine/machine-page.tsx";
import { RepositoryPage } from "@renderer/pages/repository/repository-page.tsx";

const rootRoute = createRootRoute({
  component: AppLayout,
  notFoundComponent: () => <PageHeading title="Not found" description="This location does not exist." />,
});

const machineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machine",
  component: function Machine() {
    const { draft, mutate } = useConfig();
    return <MachinePage value={draft} mutate={mutate} />;
  },
});

// Land on your work, not the infrastructure: the first repository when one
// exists, the machine page otherwise. Resolved at navigation time so the
// loader never needs config context.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    const document = queryClient.getQueryData(configQueryOptions.queryKey);
    const repositoryId =
      document?.valid ? Object.keys(document.value.repositories)[0] : undefined;
    if (repositoryId) {
      throw redirect({ to: "/repositories/$repositoryId", params: { repositoryId } });
    }
    throw redirect({ to: "/machine" });
  },
});

const providerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$providerId",
  component: function Provider() {
    const { providerId } = providerRoute.useParams();
    const { draft, mutate } = useConfig();
    return <ProviderPage id={providerId} value={draft} mutate={mutate} />;
  },
});

const connectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections/$connectionId",
  component: function Connection() {
    const { connectionId } = connectionRoute.useParams();
    const { draft, mutate } = useConfig();
    return <ConnectionPage id={connectionId} value={draft} mutate={mutate} />;
  },
});

const REPOSITORY_TABS = ["sessions", "settings", "skillsets"] as const;
export type RepositoryTab = (typeof REPOSITORY_TABS)[number];

/** Sidebar links are bare (/repositories/:id); land on the tab the user
    last used for that repository rather than resetting to Sessions. */
function lastRepositoryTab(repositoryId: string): RepositoryTab {
  const stored = localStorage.getItem(`repository-tab:${repositoryId}`);
  return REPOSITORY_TABS.includes(stored as RepositoryTab) ? (stored as RepositoryTab) : "sessions";
}

function rememberRepositoryTab(repositoryId: string, tab: RepositoryTab): void {
  localStorage.setItem(`repository-tab:${repositoryId}`, tab);
}

const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repositories/$repositoryId",
});

// Bare repository links land on the repository's last-used tab.
const repositoryIndexRoute = createRoute({
  getParentRoute: () => repositoryRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/repositories/$repositoryId/$tab",
      params: { repositoryId: params.repositoryId, tab: lastRepositoryTab(params.repositoryId) },
    });
  },
});

const repositoryTabRoute = createRoute({
  getParentRoute: () => repositoryRoute,
  path: "$tab",
  beforeLoad: ({ params }) => {
    if (!REPOSITORY_TABS.includes(params.tab as RepositoryTab)) {
      throw redirect({
        to: "/repositories/$repositoryId/$tab",
        params: { repositoryId: params.repositoryId, tab: "sessions" },
      });
    }
  },
  component: function Repository() {
    const { repositoryId, tab } = repositoryTabRoute.useParams();
    const { draft, mutate } = useConfig();
    rememberRepositoryTab(repositoryId, tab as RepositoryTab);
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

const routeTree = rootRoute.addChildren([indexRoute, machineRoute, providerRoute, connectionRoute, repositoryRoute.addChildren([repositoryIndexRoute, repositoryTabRoute])]);

// Hash history: works under the file:// URL of a packaged Electron build.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
