import { PathBar } from "@renderer/components/path-bar.tsx";
import { useHost } from "@renderer/lib/host-context.tsx";

export function MachinePathBar() {
  const { api, config } = useHost();
  const path = config.document?.path;
  if (!path) return null;
  return <PathBar path={path} icon="doc_text" onOpen={(target) => {
    if (target === path.replaceAll("\\", "/")) void api.config.openInEditor();
    else void api.shell.openPath(target);
  }} />;
}
