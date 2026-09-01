import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Code2,
  Database,
  FolderGit2,
  FolderOpen,
  GitFork,
  Laptop,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Server,
  Settings2,
  Webhook,
} from "lucide-react";

import type { ServiceFile } from "../../../lib/config.ts";
import type { ConfigDocument } from "../../../lib/config-file.ts";
import type { ManagementResult } from "../../../management/service.ts";
import type { SessionSummary } from "../../shared.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { cn } from "./lib/utils.ts";

type Selection =
  | { kind: "connection"; id: string }
  | { kind: "machine" }
  | { kind: "repository"; id: string; tab: "sessions" | "settings" };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function Field(props: {
  label: string;
  value: string | number;
  type?: string;
  disabled?: boolean;
  description?: string;
  onChange(value: string): void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      <Input
        type={props.type}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.description && <p className="text-xs text-muted-foreground">{props.description}</p>}
    </div>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between px-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

function SidebarItem(props: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick(): void;
}) {
  return (
    <button className={cn("sidebar-item", props.active && "sidebar-item-active")} onClick={props.onClick}>
      <span className="text-muted-foreground">{props.icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.detail && <span className="truncate text-[10px] text-muted-foreground">{props.detail}</span>}
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
    </button>
  );
}

export function App() {
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<ServiceFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState<ConfigDocument | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "machine" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    void window.remoteAgent.config.get().then((next) => {
      setDocument(next);
      if (next.valid) setDraft(clone(next.value));
    });
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    return window.remoteAgent.config.onChange((next) => {
      if (dirtyRef.current) {
        setExternalChange(next);
        return;
      }
      setDocument(next);
      if (next.valid) setDraft(clone(next.value));
    });
  }, []);

  const reloadExternalChange = () => {
    if (!externalChange) return;
    setDocument(externalChange);
    if (externalChange.valid) setDraft(clone(externalChange.value));
    setDirty(false);
    setExternalChange(null);
    setNotice("Reloaded changes from disk");
  };

  const mutate = (change: (value: ServiceFile) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = clone(current);
      change(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };

  const save = async () => {
    if (!draft || !document) return;
    setSaving(true);
    try {
      const next = await window.remoteAgent.config.save({
        expectedRevision: document.revision,
        value: draft,
      });
      setDocument(next);
      if (next.valid) setDraft(clone(next.value));
      setDirty(false);
      setExternalChange(null);
      setNotice("Configuration saved");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!document) {
    return <div className="grid h-screen place-items-center"><LoaderCircle className="h-6 w-6 animate-spin" /></div>;
  }

  if (!document.valid || !draft) {
    return (
      <main className="grid h-screen place-items-center bg-background p-8">
        <Card className="max-w-2xl border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CircleAlert className="h-5 w-5 text-destructive" />Configuration needs attention</CardTitle>
            <CardDescription>The file was not overwritten. Fix it in your editor and this window will update automatically.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-4 text-xs text-destructive">{document.error}</pre>
            <div className="flex gap-2">
              <Button onClick={() => void window.remoteAgent.config.openInEditor()}><Code2 className="h-4 w-4" />Open in Code Editor</Button>
              <Button variant="outline" onClick={() => void window.remoteAgent.config.reveal()}><FolderOpen className="h-4 w-4" />Reveal in Finder</Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  const connections = Object.entries(draft.connections);
  const repositories = Object.entries(draft.repositories);

  const addConnection = () => {
    const provider = window.prompt("Provider: linear or github", "linear");
    if (provider !== "linear" && provider !== "github") return;
    const id = window.prompt("Stable connection ID", `${provider}-${connections.length + 1}`)?.trim();
    if (!id || draft.connections[id]) return;
    mutate((value) => {
      value.connections[id] = provider === "linear"
        ? { provider: "linear", name: "New Linear Connection", apiKey: "replace-me", agentUserId: "replace-me" }
        : { provider: "github", name: "New GitHub Connection" };
    });
    setSelection({ kind: "connection", id });
  };

  const addRepository = () => {
    const id = window.prompt("Stable repository ID", `repository-${repositories.length + 1}`)?.trim();
    if (!id || draft.repositories[id]) return;
    mutate((value) => {
      value.repositories[id] = {
        name: "New Repository",
        root: `~/checkouts/${id}`,
        worktreeRoot: `~/.worktrees/${id}`,
        bootstrapCommand: ["true"],
        workflows: {
          describe: { prompt: "prompts/describe.md", harness: "claude" },
          orchestrate: { prompt: "prompts/orchestrate.md", harness: "codex" },
          reflect: { prompt: "prompts/reflect.md" },
        },
        metadata: { tags: {} },
        sessionDefaults: { tags: {} },
        triggers: {
          reflectOnState: "Pull Request",
          orchestrateOnState: "Planning",
          describeOnReaction: "pencil2",
        },
      };
    });
    setSelection({ kind: "repository", id, tab: "settings" });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sidebar pt-10">
        <div className="flex items-center gap-3 px-5 pb-6">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Bot className="h-5 w-5" /></div>
          <div><div className="font-semibold">Remote Agent</div><div className="text-xs text-muted-foreground">Local control plane</div></div>
        </div>
        <div className="flex-1 space-y-6 overflow-auto px-2 pb-6">
          <section>
            <SectionTitle action={<button className="icon-button" onClick={addConnection}><Plus className="h-3.5 w-3.5" /></button>}>Connections</SectionTitle>
            <div className="space-y-1">
              {connections.map(([id, connection]) => (
                <SidebarItem key={id} active={selection.kind === "connection" && selection.id === id} icon={connection.provider === "github" ? <GitFork className="h-4 w-4" /> : <Link2 className="h-4 w-4" />} label={connection.name} detail={connection.provider} onClick={() => setSelection({ kind: "connection", id })} />
              ))}
            </div>
          </section>
          <section>
            <SectionTitle>Machines</SectionTitle>
            <SidebarItem active={selection.kind === "machine"} icon={<Laptop className="h-4 w-4" />} label={draft.machine.name} detail="this machine" onClick={() => setSelection({ kind: "machine" })} />
          </section>
          <section>
            <SectionTitle action={<button className="icon-button" onClick={addRepository}><Plus className="h-3.5 w-3.5" /></button>}>Repositories</SectionTitle>
            <div className="space-y-1">
              {repositories.map(([id, repository]) => (
                <SidebarItem key={id} active={selection.kind === "repository" && selection.id === id} icon={<FolderGit2 className="h-4 w-4" />} label={repository.name ?? id} onClick={() => setSelection({ kind: "repository", id, tab: "sessions" })} />
              ))}
            </div>
          </section>
        </div>
        <div className="border-t border-border p-3">
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="flex-1" onClick={() => void window.remoteAgent.config.openInEditor()}><Code2 className="h-4 w-4" />Open in Code Editor</Button>
            <Button variant="ghost" size="icon" onClick={() => void window.remoteAgent.config.reveal()} title="Reveal in Finder"><FolderOpen className="h-4 w-4" /></Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-background/90 px-8 backdrop-blur">
          <div className="text-sm text-muted-foreground">{document.path}</div>
          <div className="flex items-center gap-3">
            {externalChange && <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-400" onClick={reloadExternalChange}><RefreshCw className="h-4 w-4" />Reload Disk Changes</Button>}
            {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
            <Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save JSON</Button>
          </div>
        </header>

        <div className="mx-auto max-w-6xl p-8">
          {selection.kind === "machine" && <MachinePage value={draft} mutate={mutate} />}
          {selection.kind === "connection" && <ConnectionPage id={selection.id} value={draft} mutate={mutate} />}
          {selection.kind === "repository" && <RepositoryPage selection={selection} setSelection={setSelection} value={draft} mutate={mutate} />}
        </div>
      </main>
    </div>
  );
}

function PageHeading({ title, description, badge }: { title: string; description: string; badge?: string }) {
  return <div className="mb-7"><div className="mb-2 flex items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{badge && <Badge>{badge}</Badge>}</div><p className="text-sm text-muted-foreground">{description}</p></div>;
}

function MachinePage({ value, mutate }: { value: ServiceFile; mutate(change: (value: ServiceFile) => void): void }) {
  const [result, setResult] = useState<ManagementResult | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const run = async (action: "status" | "doctor" | "install" | "check-update" | "update" | "restart") => {
    setWorking(action);
    try { setResult(await window.remoteAgent.management.run(action)); }
    finally { setWorking(null); }
  };
  const machine = value.machine;
  return (
    <>
      <PageHeading title={machine.name} badge="This Machine" description="The only execution target in this installation. All sessions and acpx state remain local." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Server className="h-4 w-4" />Service</CardTitle><CardDescription>Install, inspect, and update the local daemon.</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void run("status")}><RefreshCw className={cn("h-4 w-4", working === "status" && "animate-spin")} />Status</Button>
              <Button size="sm" variant="outline" onClick={() => void run("doctor")}><CheckCircle2 className="h-4 w-4" />Doctor</Button>
              <Button size="sm" variant="outline" onClick={() => void run("install")}><Server className="h-4 w-4" />Install Service</Button>
              <Button size="sm" variant="outline" onClick={() => void run("restart")}><RotateCw className="h-4 w-4" />Restart</Button>
              <Button size="sm" variant="outline" onClick={() => void run("check-update")}><RefreshCw className="h-4 w-4" />Check Updates</Button>
              <Button size="sm" onClick={() => void run("update")}>Install Update</Button>
            </div>
            {result && <div className={cn("rounded-lg border p-3 text-sm", result.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5")}><div className="font-medium">{result.summary}</div>{result.detail && <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{result.detail}</pre>}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" />Identity & storage</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Machine ID" value={machine.id} onChange={(next) => mutate((file) => { file.machine.id = next; })} />
            <Field label="Display name" value={machine.name} onChange={(next) => mutate((file) => { file.machine.name = next; })} />
            <Field label="Database URL" value={machine.server.databaseUrl ?? ""} onChange={(next) => mutate((file) => { file.machine.server.databaseUrl = next; })} />
            <Field label="acpx state directory" value={machine.acpx.stateDir ?? ""} onChange={(next) => mutate((file) => { file.machine.acpx.stateDir = next; })} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Server</CardTitle><CardDescription>Listen settings require a daemon restart.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Host" value={machine.server.listen.host} onChange={(next) => mutate((file) => { file.machine.server.listen.host = next; })} />
            <Field label="Port" type="number" value={machine.server.listen.port} onChange={(next) => mutate((file) => { file.machine.server.listen.port = Number(next); })} />
            <div className="sm:col-span-2"><Field label="Public URL" value={machine.server.publicUrl} onChange={(next) => mutate((file) => { file.machine.server.publicUrl = next; })} /></div>
            <div className="sm:col-span-2"><Field label="ACP socket" value={machine.server.acpSocketPath ?? ""} onChange={(next) => mutate((file) => { file.machine.server.acpSocketPath = next; })} /></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Zed & runtime</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2"><Label>Connection</Label><select className="select" value={machine.zed.connection} onChange={(event) => mutate((file) => { file.machine.zed.connection = event.target.value as "local" | "ssh"; })}><option value="local">Local</option><option value="ssh">SSH</option></select></div>
            {machine.zed.connection === "ssh" && <Field label="SSH host" value={machine.zed.remoteHost ?? ""} onChange={(next) => mutate((file) => { file.machine.zed.remoteHost = next; })} />}
            <Field label="Codex executable" value={machine.runtime.codexExecutable} onChange={(next) => mutate((file) => { file.machine.runtime.codexExecutable = next; })} />
            <div className="grid gap-2"><Label>Permission mode</Label><select className="select" value={machine.acpx.permissionMode} onChange={(event) => mutate((file) => { file.machine.acpx.permissionMode = event.target.value as typeof file.machine.acpx.permissionMode; })}><option value="approve-all">Approve all</option><option value="approve-reads">Approve reads</option><option value="deny-all">Deny all</option></select></div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ConnectionPage({ id, value, mutate }: { id: string; value: ServiceFile; mutate(change: (value: ServiceFile) => void): void }) {
  const connection = value.connections[id];
  if (!connection) return <PageHeading title="Connection not found" description={id} />;
  const webhooks = Object.entries(value.machine.server.webhooks).filter(([, webhook]) => webhook.connection === id);
  return (
    <>
      <PageHeading title={connection.name} badge={connection.provider} description="Provider credentials and the inbound server bindings that reference this connection." />
      <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
        <Card>
          <CardHeader><CardTitle>Connection settings</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field label="Connection ID" value={id} disabled onChange={() => {}} description="Stable JSON key; renaming requires updating webhook references." />
            <Field label="Display name" value={connection.name} onChange={(next) => mutate((file) => { file.connections[id]!.name = next; })} />
            <div className="grid gap-2"><Label>Machine</Label><select className="select" value={value.machine.id} disabled><option value={value.machine.id}>{value.machine.name}</option></select><p className="text-xs text-muted-foreground">Multi-machine orchestration is not supported yet.</p></div>
            {connection.provider === "linear" ? <>
              <Field label="Linear API key" type="password" value={connection.apiKey} onChange={(next) => mutate((file) => { const current = file.connections[id]; if (current?.provider === "linear") current.apiKey = next; })} />
              <Field label="Agent user ID" value={connection.agentUserId} onChange={(next) => mutate((file) => { const current = file.connections[id]; if (current?.provider === "linear") current.agentUserId = next; })} />
              <Field label="Agent handle" value={connection.agentHandle ?? ""} onChange={(next) => mutate((file) => { const current = file.connections[id]; if (current?.provider === "linear") current.agentHandle = next || undefined; })} />
            </> : <Field label="GitHub API token (optional)" type="password" value={connection.apiToken ?? ""} onChange={(next) => mutate((file) => { const current = file.connections[id]; if (current?.provider === "github") current.apiToken = next || undefined; })} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Webhook className="h-4 w-4" />Server webhooks</CardTitle><CardDescription>Stored under machine.server.webhooks in JSON.</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {webhooks.length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No inbound webhook uses this connection.</div>}
            {webhooks.map(([webhookId, webhook]) => <div key={webhookId} className="rounded-lg border border-border p-4"><div className="mb-3 flex items-center justify-between"><span className="font-medium">{webhookId}</span><Badge>/{webhookId}</Badge></div><Field label="Webhook secret" type="password" value={webhook.secret} onChange={(next) => mutate((file) => { file.machine.server.webhooks[webhookId]!.secret = next; })} /><div className="mt-3 text-xs text-muted-foreground">Routes to: {Object.keys(webhook.repositoryRouting).join(", ") || "deployment endpoint"}</div></div>)}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function RepositoryPage({ selection, setSelection, value, mutate }: { selection: Extract<Selection, { kind: "repository" }>; setSelection(value: Selection): void; value: ServiceFile; mutate(change: (value: ServiceFile) => void): void }) {
  const repository = value.repositories[selection.id];
  if (!repository) return <PageHeading title="Repository not found" description={selection.id} />;
  return (
    <>
      <PageHeading title={repository.name ?? selection.id} badge={selection.id} description={repository.root} />
      <div className="mb-6 flex w-fit rounded-lg bg-muted p-1">
        {(["sessions", "settings"] as const).map((tab) => <button key={tab} className={cn("rounded-md px-4 py-1.5 text-sm capitalize text-muted-foreground", selection.tab === tab && "bg-background text-foreground shadow-sm")} onClick={() => setSelection({ ...selection, tab })}>{tab === "settings" ? "Repository Settings" : "Sessions"}</button>)}
      </div>
      {selection.tab === "sessions" ? <SessionsPage repositoryId={selection.id} /> : <RepositorySettings id={selection.id} value={value} mutate={mutate} />}
    </>
  );
}

function SessionsPage({ repositoryId }: { repositoryId: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true); setError(null);
    try { setSessions(await window.remoteAgent.sessions.list(repositoryId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [repositoryId]);
  const counts = useMemo(() => ({ active: sessions.filter((session) => session.status === "active").length, total: sessions.length }), [sessions]);
  return <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Sessions</CardTitle><CardDescription>{counts.active} active · {counts.total} total</CardDescription></div><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />Refresh</Button></CardHeader><CardContent>{error ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">Daemon unavailable: {error}</div> : <div className="overflow-hidden rounded-lg border border-border"><table className="w-full text-sm"><thead className="bg-muted/60 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3">Session</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Harness</th><th className="px-4 py-3">Tags</th><th className="px-4 py-3">Updated</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.id} className="border-t border-border"><td className="max-w-[260px] px-4 py-3"><div className="truncate font-medium">{session.name ?? session.id}</div><div className="truncate font-mono text-[10px] text-muted-foreground">{session.id}</div></td><td className="px-4 py-3"><Badge className={cn(session.status === "active" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-400")}>{session.status}</Badge></td><td className="px-4 py-3 text-muted-foreground">{session.role ?? "—"}</td><td className="px-4 py-3">{session.agentCommand}</td><td className="px-4 py-3"><div className="flex max-w-[260px] flex-wrap gap-1">{session.tags.map((tag) => <Badge key={`${tag.key}:${tag.value}`}>{tag.key}:{tag.value}</Badge>)}</div></td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{new Date(session.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>{!loading && sessions.length === 0 && <div className="p-10 text-center text-sm text-muted-foreground">No sessions for this repository.</div>}</div>}</CardContent></Card>;
}

function RepositorySettings({ id, value, mutate }: { id: string; value: ServiceFile; mutate(change: (value: ServiceFile) => void): void }) {
  const repository = value.repositories[id]!;
  return <div className="grid gap-5 lg:grid-cols-2"><Card><CardHeader><CardTitle>Paths & bootstrap</CardTitle></CardHeader><CardContent className="grid gap-4"><Field label="Display name" value={repository.name ?? id} onChange={(next) => mutate((file) => { file.repositories[id]!.name = next; })} /><Field label="Checkout root" value={repository.root} onChange={(next) => mutate((file) => { file.repositories[id]!.root = next; })} /><Field label="Worktree root" value={repository.worktreeRoot} onChange={(next) => mutate((file) => { file.repositories[id]!.worktreeRoot = next; })} /><Field label="Bootstrap command" value={repository.bootstrapCommand.join(" ")} onChange={(next) => mutate((file) => { file.repositories[id]!.bootstrapCommand = next.split(/\s+/).filter(Boolean); })} /></CardContent></Card><Card><CardHeader><CardTitle>Workflow triggers</CardTitle></CardHeader><CardContent className="grid gap-4"><Field label="Orchestrate on state" value={repository.triggers.orchestrateOnState} onChange={(next) => mutate((file) => { file.repositories[id]!.triggers.orchestrateOnState = next; })} /><Field label="Reflect on state" value={repository.triggers.reflectOnState} onChange={(next) => mutate((file) => { file.repositories[id]!.triggers.reflectOnState = next; })} /><Field label="Describe reaction" value={repository.triggers.describeOnReaction} onChange={(next) => mutate((file) => { file.repositories[id]!.triggers.describeOnReaction = next; })} /></CardContent></Card><Card className="lg:col-span-2"><CardHeader><CardTitle>Workflow prompts</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-3"><Field label="Describe prompt" value={repository.workflows.describe.prompt} onChange={(next) => mutate((file) => { file.repositories[id]!.workflows.describe.prompt = next; })} /><Field label="Orchestrate prompt" value={repository.workflows.orchestrate.prompt} onChange={(next) => mutate((file) => { file.repositories[id]!.workflows.orchestrate.prompt = next; })} /><Field label="Reflect prompt" value={repository.workflows.reflect.prompt} onChange={(next) => mutate((file) => { file.repositories[id]!.workflows.reflect.prompt = next; })} /></CardContent></Card><Card className="lg:col-span-2"><CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="h-4 w-4" />Metadata definitions</CardTitle><CardDescription>String-only tags configured for this repository. Use the JSON editor for advanced editing.</CardDescription></CardHeader><CardContent><div className="grid gap-2">{Object.entries(repository.metadata.tags).map(([key, definition]) => <div key={key} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"><code className="text-xs">{key}</code><Badge>{definition.cardinality}</Badge>{definition.routerVisible && <Badge>router visible</Badge>}<span className="ml-auto text-xs text-muted-foreground">{definition.options?.join(", ") ?? "free text"}</span></div>)}{Object.keys(repository.metadata.tags).length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No custom metadata definitions.</div>}</div></CardContent></Card></div>;
}
