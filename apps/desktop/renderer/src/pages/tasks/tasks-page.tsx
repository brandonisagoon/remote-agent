import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DesktopTask, DesktopTaskActivity } from "../../../../../../lib/desktop-host.ts";
import { useHost } from "@renderer/lib/host-context.tsx";
import { useTaskDraft } from "@renderer/lib/task-draft.ts";
import { Button } from "@renderer/components/ui/button.tsx";
import { Badge } from "@renderer/components/ui/badge.tsx";
import { Textarea } from "@renderer/components/ui/textarea.tsx";
import { OpenInEditorMenu } from "@renderer/components/open-in-editor-menu.tsx";
import { cn } from "@renderer/lib/utils.ts";

export function TasksPage() {
  const { host, status } = useHost();
  const query = useQuery({ queryKey: ["tasks", host.id], queryFn: () => window.remoteAgent.tasks.list(), refetchInterval: 4000, retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const tasks = query.data ?? [];
  useEffect(() => { if (!selected && tasks[0]) setSelected(tasks[0].id); }, [selected, tasks]);
  return <div className="grid gap-5">
    <div className="flex items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">Tasks on {host.name}</h1><p className="text-muted-foreground mt-1 text-sm">Continue work, answer questions, or open a preview.</p></div><Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh</Button></div>
    {(!status?.connected || query.error) && <div role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">Showing the last received state. Reconnecting to {host.name}… Actions will return when the connection is available.</div>}
    {!query.data && query.isFetching && <p className="text-muted-foreground py-12 text-center text-sm">Loading tasks…</p>}
    {query.data?.length === 0 && <p className="text-muted-foreground py-12 text-center text-sm">No tasks on this machine yet. Start work from a connected Linear issue or owner session.</p>}
    {tasks.length > 0 && <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.5fr)]">
      <div className="overflow-hidden rounded-lg border" aria-label="Tasks">
        {tasks.map((task) => <TaskRow key={task.id} task={task} selected={selected === task.id} select={() => setSelected(task.id)} />)}
      </div>
      {selected && <TaskDetail key={selected} id={selected} connected={!!status?.connected && !!status.serverAvailable && !query.isError} />}
    </div>}
  </div>;
}

function TaskRow({ task, selected, select }: { task: DesktopTask; selected: boolean; select(): void }) {
  return <button aria-pressed={selected} onClick={select} className={cn("hover:bg-muted/60 block w-full border-b p-3 text-left transition-colors last:border-b-0 motion-reduce:transition-none", selected && "bg-muted")}>
    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{task.issueIdentifier ?? task.repositoryId}</span><Badge variant={task.phase === "waiting" ? "default" : "secondary"}>{task.phase}</Badge></div>
    <div className="text-muted-foreground mt-1 truncate text-xs">{task.branchName}</div>
    <div className="text-muted-foreground mt-2 text-[11px]">Environment {task.environmentStatus} · {new Date(task.updatedAt).toLocaleString()}</div>
  </button>;
}

function TaskDetail({ id, connected }: { id: string; connected: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["task-activity", id], queryFn: () => window.remoteAgent.tasks.activity(id), refetchInterval: 5000, retry: false });
  const [working, setWorking] = useState<string | null>(null);
  const refresh = () => { void query.refetch(); void queryClient.invalidateQueries({ queryKey: ["tasks"] }); };
  const act = async (name: string, action: () => Promise<unknown>) => {
    setWorking(name);
    try { await action(); refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); refresh(); }
    finally { setWorking(null); }
  };
  const data = query.data;
  if (!data) return <div className="text-muted-foreground rounded-lg border p-6 text-sm">{query.error ? String(query.error) : "Loading this session…"}</div>;
  const disabled = !connected || !!working || query.isError;
  const task = data.task;
  const browserOwnsControl = !!task.controllerId && task.controllerId !== `task-supervisor:${id}`;
  const previews = task.resources.filter((resource) => resource.kind === "local-http" && resource.state !== "released");
  const pending = data.questions.filter((question) => question.state !== "answered");
  return <section aria-label="Selected task" className="min-w-0 rounded-lg border">
    <div className="grid gap-3 border-b p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{task.issueIdentifier ?? task.repositoryId}</h2><Badge variant="outline">{task.controlMode === "agent" ? data.session?.status ?? "preparing" : task.controlMode}</Badge></div>
      <p className="text-muted-foreground break-all text-xs">{task.branchName}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={disabled || task.phase === "closed" || task.controlMode !== "agent"} onClick={() => void act("pause", () => window.remoteAgent.tasks.control(id, "pause"))}>Pause</Button>
        <Button size="sm" variant="outline" disabled={disabled || task.phase === "closed" || task.controlMode === "agent" || browserOwnsControl} onClick={() => void act("resume", () => window.remoteAgent.tasks.control(id, "resume"))}>Resume</Button>
        <Button size="sm" variant="ghost" disabled={disabled || task.phase === "closed" || browserOwnsControl} onClick={() => { if (window.confirm("Close this agent session? Its worktree, history and retained previews stay available.")) void act("close", () => window.remoteAgent.tasks.control(id, "close")); }}>Close task</Button>
        {task.worktreePath && <OpenInEditorMenu target={task.worktreePath} />}
      </div>
      {task.primarySessionId && <p className="text-muted-foreground break-all text-[11px]">Session {task.primarySessionId}</p>}
      {task.recoveryDetail && <p className="text-muted-foreground whitespace-pre-wrap text-xs">{task.recoveryDetail}</p>}
      {browserOwnsControl && <p className="text-sm">Browser control is held by you. Return control from its viewer before resuming.</p>}
      {task.controlMode === "paused" && !browserOwnsControl && <p className="text-sm">Automation is paused. Messages wait until you resume.</p>}
      {query.isError && <p role="alert" className="text-destructive text-xs">This view may be out of date. {String(query.error)}</p>}
    </div>
    {previews.length > 0 && <div className="flex flex-wrap gap-2 border-b p-4">{previews.map((resource) => <Button size="sm" key={resource.id} variant="outline" disabled={disabled} onClick={() => void act(resource.id, async () => { const url = await window.remoteAgent.tasks.preview(id, resource.id); window.open(url); })}>{resource.key === "browser-viewer" ? "Watch browser" : resource.purpose === "review" ? "Open review" : "Open preview"}</Button>)}</div>}
    {pending.map((question) => <TaskQuestion key={question.id} taskId={id} question={question} disabled={disabled} updated={refresh} />)}
    {task.phase !== "closed" && <TaskMessage taskId={id} disabled={disabled} updated={refresh} />}
    <TaskInstructions taskId={id} instructions={data.instructions} disabled={disabled} updated={refresh} />
    <TaskHistory history={data.history} />
  </section>;
}

function TaskQuestion({ taskId, question, disabled, updated }: { taskId: string; question: DesktopTaskActivity["questions"][number]; disabled: boolean; updated(): void }) {
  const field = useId();
  const { draft, setDraft } = useTaskDraft(`${taskId}:question:${question.id}`);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setDraft({ ...draft, requestKey: question.id }); setSending(true); setError(null);
    try { await window.remoteAgent.tasks.answer(taskId, question.id, draft.text); setDraft({ text: "" }); updated(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); updated(); }
    finally { setSending(false); }
  };
  return <div className="grid gap-3 border-b p-4"><label htmlFor={field} className="whitespace-pre-wrap text-sm font-medium">{question.body}</label><Textarea id={field} value={draft.text} onChange={(event) => setDraft({ text: event.target.value })} readOnly={!!draft.requestKey} disabled={sending} placeholder="Your answer" /><div className="flex gap-2"><Button size="sm" disabled={disabled || sending || !draft.text.trim()} onClick={() => void send()}>{sending ? "Sending…" : draft.requestKey ? "Retry answer" : "Answer question"}</Button><Button size="sm" variant="ghost" disabled={sending || !draft.text} onClick={() => { setDraft({ text: "" }); setError(null); }}>Clear draft</Button></div>{error && <p role="alert" className="text-destructive text-xs">{error}</p>}</div>;
}

function TaskMessage({ taskId, disabled, updated }: { taskId: string; disabled: boolean; updated(): void }) {
  const field = useId();
  const { draft, setDraft } = useTaskDraft(`${taskId}:message`);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const request = { text: draft.text, requestKey: draft.requestKey ?? crypto.randomUUID() };
    setDraft(request); setSending(true); setError(null);
    try { await window.remoteAgent.tasks.instruct(taskId, request.requestKey, request.text); setDraft({ text: "" }); updated(); toast.success("Message queued for this session"); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); updated(); }
    finally { setSending(false); }
  };
  return <div className="grid gap-3 border-b p-4"><label htmlFor={field} className="text-sm font-medium">Continue this session</label><Textarea id={field} value={draft.text} onChange={(event) => setDraft({ text: event.target.value })} readOnly={!!draft.requestKey} disabled={sending} placeholder="Tell the agent what to do next…" /><div className="flex gap-2"><Button size="sm" disabled={disabled || sending || !draft.text.trim()} onClick={() => void send()}>{sending ? "Sending…" : draft.requestKey ? "Retry same message" : "Send message"}</Button><Button size="sm" variant="ghost" disabled={sending || !draft.text} onClick={() => { setDraft({ text: "" }); setError(null); if (draft.requestKey) toast.info("Draft cleared. An already delivered message remains in the session."); }}>Clear draft</Button></div>{error && <p role="alert" className="text-destructive text-xs">{error} A retry keeps the same message identity.</p>}</div>;
}

function TaskInstructions({ taskId, instructions, disabled, updated }: { taskId: string; instructions: DesktopTaskActivity["instructions"]; disabled: boolean; updated(): void }) {
  const pending = instructions.filter((instruction) => ["queued", "dispatching", "unknown", "failed"].includes(instruction.state));
  if (!pending.length) return null;
  return <div className="grid gap-3 border-b p-4"><h3 className="text-sm font-medium">Message status</h3>{pending.map((instruction) => <div key={instruction.id} className="text-xs"><Badge variant="secondary">{instruction.state === "dispatching" ? "In progress" : instruction.state}</Badge><p className="mt-1 whitespace-pre-wrap">{instruction.text}</p>{instruction.detail && <p className="text-muted-foreground mt-1">{instruction.detail}</p>}{instruction.state === "unknown" && <ResolveInstruction taskId={taskId} instructionId={instruction.id} disabled={disabled} updated={updated} />}</div>)}</div>;
}

function ResolveInstruction({ taskId, instructionId, disabled, updated }: { taskId: string; instructionId: string; disabled: boolean; updated(): void }) {
  const field = useId();
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const resolve = async (action: "acknowledge" | "cancel" | "retry") => {
    if (action === "retry" && !window.confirm("Retry this message? Check the conversation first: a previous delivery may already have performed its actions.")) return;
    setWorking(true);
    try { await window.remoteAgent.tasks.resolve(taskId, instructionId, action, reason); updated(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); }
  };
  return <div className="mt-3 grid gap-2"><label htmlFor={field}>Check the conversation and record why you chose this resolution.</label><Textarea id={field} value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} disabled={working} placeholder="What happened to this message?" /><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled || working || !reason.trim()} onClick={() => void resolve("acknowledge")}>Mark delivered</Button><Button size="sm" variant="outline" disabled={disabled || working || !reason.trim()} onClick={() => void resolve("retry")}>Retry message</Button><Button size="sm" variant="ghost" disabled={disabled || working || !reason.trim()} onClick={() => void resolve("cancel")}>Cancel message</Button></div></div>;
}

function TaskHistory({ history }: { history: unknown[] }) {
  const [limit, setLimit] = useState(10);
  const messages = history.filter((item): item is { role: string; text: string } => !!item && typeof item === "object" && "text" in item && typeof item.text === "string" && "role" in item && typeof item.role === "string");
  return <div className="grid gap-4 p-4"><h3 className="text-sm font-medium">Conversation</h3>{messages.length > limit && <Button size="sm" variant="outline" onClick={() => setLimit((value) => value + 20)}>Show earlier messages</Button>}{messages.slice(-limit).map((message, index) => <div key={messages.length - Math.min(limit, messages.length) + index} className="min-w-0"><div className="text-muted-foreground mb-1 text-xs font-medium">{message.role === "user" ? "You" : "Agent"}</div><p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p></div>)}{!messages.length && <p className="text-muted-foreground text-sm">No conversation yet.</p>}</div>;
}
