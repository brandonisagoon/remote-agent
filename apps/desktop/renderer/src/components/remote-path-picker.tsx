import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import type { DesktopHost } from "../../../../../lib/desktop-host.ts";

type Choice = { host: DesktopHost; title: string; path: string; kind: "folder" | "file"; resolve(path: string | null): void };
let showPicker: ((choice: Choice) => void) | undefined;
export async function chooseHostPath(host: DesktopHost, title: string, initial = "", kind: "folder" | "file" = "folder") {
  const api = window.remoteAgent.forHost(host.id);
  if (host.kind === "local") return kind === "folder" ? api.fs.pickFolder(title, initial) : api.fs.pickFile(title, initial);
  return new Promise<string | null>((resolve) => { if (!showPicker) return resolve(null); showPicker({ host, title, path: initial, kind, resolve }); });
}
export async function chooseHostRepository(host: DesktopHost) {
  const root = await chooseHostPath(host, "Add repository");
  return root ? window.remoteAgent.forHost(host.id).repository.validate(root) : null;
}
export function RemotePathPicker() {
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => { showPicker = setChoice; return () => { showPicker = undefined; }; }, []);
  const close = () => { choice?.resolve(null); setChoice(null); };
  return <Dialog open={!!choice} onOpenChange={(open) => { if (!open) close(); }}><DialogContent className="sm:max-w-xl motion-reduce:animate-none"><DialogHeader><DialogTitle>{choice?.title ?? "Choose a path"}</DialogTitle><DialogDescription>Browse files on {choice?.host.name}.</DialogDescription></DialogHeader>{choice && <RemotePathChoices key={choice.host.id + choice.title + choice.path} choice={choice} finish={(path) => { choice.resolve(path); setChoice(null); }} />}</DialogContent></Dialog>;
}
function RemotePathChoices({ choice, finish }: { choice: Choice; finish(path: string): void }) {
  const { host } = choice;
  const api = window.remoteAgent.forHost(host.id);
  const [directory, setDirectory] = useState(choice.path);
  const [input, setInput] = useState(choice.path);
  const listing = useQuery({ queryKey: ["host-paths", host.id, directory, choice.kind], queryFn: () => api.fs.list(directory, choice.kind), retry: false });
  return <div className="grid gap-3"><form onSubmit={(event) => { event.preventDefault(); setDirectory(input); }} className="flex gap-2"><Input aria-label={`Path on ${host.name}`} value={input} onChange={(event) => setInput(event.target.value)} /><Button type="submit" variant="outline">Go</Button></form>
    <div className="text-muted-foreground text-xs">{host.name} · {listing.data?.path ?? directory}</div>
    {listing.error && <p role="alert" className="text-destructive text-sm">{String(listing.error)}</p>}
    <div className="h-64 overflow-auto rounded-md border p-1">
      <button className="hover:bg-muted block w-full rounded p-2 text-left text-sm" disabled={!listing.data} onClick={() => { setDirectory(listing.data!.parent); setInput(listing.data!.parent); }}>↑ Parent folder</button>
      {listing.data?.entries.map((entry) => <button key={entry.path} className="hover:bg-muted block w-full truncate rounded p-2 text-left text-sm" onClick={() => { if (entry.directory) { setDirectory(entry.path); setInput(entry.path); } else finish(entry.path); }}>{entry.directory ? "▸ " : ""}{entry.name}</button>)}
    </div>
    {choice.kind === "folder" && <Button disabled={!listing.data || listing.isError} onClick={() => finish(listing.data!.path)}>Choose this folder</Button>}
  </div>;
}
