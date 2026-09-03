import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AppLayout } from "@renderer/components/app-layout.tsx";
import { PageHeading } from "@renderer/components/page-heading.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import { ConnectionPage } from "@renderer/pages/connection-page.tsx";
import { HarnessPage } from "@renderer/pages/harness-page.tsx";
import { MachinePage } from "@renderer/pages/machine-page.tsx";
import { RepositoryPage } from "@renderer/pages/repository-page.tsx";

const rootRoute = createRootRoute({
  component: AppLayout,
  notFoundComponent: () => <PageHeading title="Not found" description="This location does not exist." />,
});

const machineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Machine() {
    const { draft, mutate } = useConfig();
    return <MachinePage value={draft} mutate={mutate} />;
  },
});

const harnessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/harnesses/$harnessId",
  component: function Harness() {
    const { harnessId } = harnessRoute.useParams();
    const { draft, mutate } = useConfig();
    return <HarnessPage id={harnessId} value={draft} mutate={mutate} />;
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

const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repositories/$repositoryId",
  component: function Repository() {
    const { repositoryId } = repositoryRoute.useParams();
    const { draft, mutate } = useConfig();
    return <RepositoryPage id={repositoryId} value={draft} mutate={mutate} />;
  },
});

const routeTree = rootRoute.addChildren([machineRoute, harnessRoute, connectionRoute, repositoryRoute]);

// Hash history: works under the file:// URL of a packaged Electron build.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
