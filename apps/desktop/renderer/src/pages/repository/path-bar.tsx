import { useHost } from "@renderer/lib/host-context.tsx";
import { PathBar } from "@renderer/components/path-bar.tsx";
import { useConfig } from "@renderer/lib/config-context.tsx";

/** Finder-style path bar pinned to the window footer on repository routes.
    Clicking a segment reveals that folder. */
export function RepositoryPathBar({ repositoryId }: { repositoryId: string }) {
  const { api } = useHost();
  const { draft } = useConfig();
  const repository = draft.repositories[repositoryId];
  if (!repository) return null;
  return <PathBar path={repository.root} onOpen={(target) => void api.shell.openPath(target)} />;
}
