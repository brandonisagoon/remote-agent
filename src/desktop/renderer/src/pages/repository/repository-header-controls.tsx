import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/tabs.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";
import {
  setRepositoryTab,
  useRepositoryTab,
  type RepositoryTab,
} from "./tab-store.ts";

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
  const tab = useRepositoryTab(repositoryId);
  if (!repository) return null;

  return (
    <>
      {/* Absolutely centered in the header so left/right widgets don't shift it. */}
      <Tabs
        value={tab}
        onValueChange={(next) => setRepositoryTab(repositoryId, next as RepositoryTab)}
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
