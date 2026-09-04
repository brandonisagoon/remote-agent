import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { useNavigate, useParams } from "@tanstack/react-router";

import { useConfig } from "@renderer/lib/config-context.tsx";
import type { RepositoryTab } from "@renderer/router.tsx";

const TABS: Array<{ id: RepositoryTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
  { id: "skillsets", label: "Skillsets" },
];

/** Header widgets for repository routes: the page tabs and an Open in Editor
    dropdown listing every detected editor app. */
export function RepositoryHeaderControls({ repositoryId }: { repositoryId: string }) {
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { tab?: string };
  const tab = (params.tab as RepositoryTab | undefined) ?? "sessions";
  if (!repository) return null;

  return (
    <>
      {/* Absolutely centered in the header so left/right widgets don't shift it. */}
      <Tabs
        value={tab}
        onValueChange={(next) =>
          void navigate({
            to: "/repositories/$repositoryId/$tab",
            params: { repositoryId, tab: next as RepositoryTab },
          })
        }
        className="absolute left-1/2 -translate-x-1/2"
      >
        <TabsList>
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <span className="ml-auto">
        <OpenInEditorMenu target={repository.root} />
      </span>
    </>
  );
}
