import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFile, lstat, mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeStore, type AcpSessionRecord } from "acpx/runtime";
import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { createApp } from "../../app.ts";
import { createAcpxSessionRuntime } from "./session-runtime.ts";

let db: TestDatabase, directory: string;
beforeEach(async () => { db = await createTestDatabase(); directory = await mkdtemp(path.join(tmpdir(), "closed-history-")); });
afterEach(async () => { await db.cleanup(); await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const cwd = path.join(directory, "removed-checkout"), stateDir = path.join(directory, "state");
  const config = testConfig({ acpxStateDir: stateDir });
  const store = createRuntimeStore({ stateDir });
  const now = new Date().toISOString();
  const expected = Array.from({ length: 62 }, (_, i) => ({ role: i % 2 ? "agent" as const : "user" as const, text: `Synthetic saved message ${i}` }));
  const records: Record<string, AcpSessionRecord> = {};
  for (const id of ["primary", "delegate"]) {
    await db.prisma.runtimeSession.create({ data: { id, scopeKey: id, repositoryId: "repo", machineId: "machine", agentCommand: "codex", cwd, name: id,
      role: id === "primary" ? "primary" : "delegate", status: "closed", closedAt: new Date(), acpxRecordId: `record-${id}`, acpxSessionId: `backend-${id}`, agentSessionId: `agent-${id}` } });
    const record: AcpSessionRecord = { schema: "acpx.session.v1", acpxRecordId: `record-${id}`, acpSessionId: `backend-${id}`, agentSessionId: `agent-${id}`, agentCommand: "codex", cwd, name: id,
      createdAt: now, lastUsedAt: now, lastSeq: 0, closed: false, // Historical provider flag need not match logical closure.
      eventLog: { active_path: `${id}.events.jsonl`, segment_count: 1, max_segment_bytes: 1048576, max_segments: 5 },
      messages: expected.map((m,i) => m.role === "user" ? { User: { id: `user-${i}`, content: [{ Text: m.text }] } } : { Agent: { content: [{ Text: m.text }], tool_results: {} } }),
      updated_at: now, cumulative_token_usage: {}, request_token_usage: {} };
    records[id] = record; await store.save(record);
  }
  await db.prisma.runtimeSessionRelation.create({ data: { sourceSessionId: "delegate", targetSessionId: "primary", relationship: "spawned-by" } });
  const task = await db.prisma.remoteTask.create({ data: { id: "task", requestKey: "task", repositoryId: "repo", machineId: "machine", branchName: "codex/closed", worktreePath: cwd,
    toolingRoot: "/unused", toolingRevision: "a".repeat(40), primarySessionId: "primary", phase: "closed" } });
  const runtime = createAcpxSessionRuntime(db.prisma, config);
  const app = createApp({ config, prisma: db.prisma, agentRuntime: runtime });
  const headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
  return { cwd, stateDir, store, records, expected, runtime, app, headers, config, task };
}
async function unchangedState() {
  return { sessions: await db.prisma.runtimeSession.findMany({ orderBy: { id: "asc" } }), tasks: await db.prisma.remoteTask.findMany(),
    relations: await db.prisma.runtimeSessionRelation.findMany(), instructions: await db.prisma.runtimeInstruction.findMany(), metadata: await db.prisma.runtimeMetadataEvent.findMany() };
}

test("actual activity route reads complete closed primary and delegate history without source, provider or writes", async () => {
  const f = await fixture(), before = await unchangedState();
  const files = await Promise.all(["primary", "delegate"].map(async id => { const file = path.join(f.stateDir, "sessions", `record-${id}.json`); return {file,bytes:await readFile(file),stat:await lstat(file)}; }));
  const socket = path.join(directory, "history.sock");
  const server = Bun.serve({ unix: socket, fetch: f.app.fetch });
  const request = (headers?: Record<string,string>) => fetch("http://local/api/tasks/task/activity", {unix:socket,headers});
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw Error("History must not spawn a provider"); });
  const kill = spyOn(process, "kill").mockImplementation(() => { throw Error("History must not probe or signal a process"); });
  try {
    const denied = await request(); expect(denied.status).toBe(401);
    const response = await request(f.headers); expect(response.status).toBe(200);
    const value:any = await response.json();
    expect(value.history).toEqual(f.expected); expect(value.activity.readErrors).toEqual([]); expect(value.activity.state).toBe("closed");
    expect(value.delegates.map((d:any)=>d.session.id)).toEqual(["delegate"]);
    expect(value.delegates[0].history).toEqual(f.expected); expect(value.delegates[0].activity.readErrors).toEqual([]);
    expect(await createAcpxSessionRuntime(db.prisma,f.config).history("delegate")).toEqual(f.expected);
    expect(spawn).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); kill.mockRestore(); await server.stop(true); }
  expect(await unchangedState()).toEqual(before); expect(await lstat(f.cwd).catch(()=>null)).toBeNull();
  for(const old of files){expect(await readFile(old.file)).toEqual(old.bytes); const current=await lstat(old.file); expect([current.ino,current.size,current.mtimeMs,current.mode]).toEqual([old.stat.ino,old.stat.size,old.stat.mtimeMs,old.stat.mode]);}
});

test("closed history with missing storage reports unavailable without creating any directory", async () => {
  const f=await fixture(); await rm(f.stateDir,{recursive:true});
  await expect(f.runtime.history("delegate")).rejects.toThrow("history");
  expect(await lstat(f.stateDir).catch(()=>null)).toBeNull();
});

test("closed history is also read-only when a late provider update left status idle with closedAt", async () => {
  const f=await fixture(); await db.prisma.runtimeSession.update({where:{id:"primary"},data:{status:"idle"}});
  const before=await unchangedState(); expect(await f.runtime.history("primary")).toEqual(f.expected); expect(await unchangedState()).toEqual(before);
});

test("closed saved identity rejects foreign record, backend, cwd and agent session", async () => {
  const f=await fixture(), file=path.join(f.stateDir,"sessions","record-delegate.json"), original=JSON.parse(await readFile(file,"utf8"));
  for(const change of [{acpx_record_id:"record-foreign"},{acp_session_id:"backend-foreign"},{cwd:"/another-task"},{agent_session_id:"agent-foreign"}]) {
    await writeFile(file,JSON.stringify({...original,...change}));
    await expect(f.runtime.history("delegate")).rejects.toThrow("different session");
    const response=await f.app.request("/api/tasks/task/activity",{headers:f.headers}), activity:any=await response.json();
    expect(activity.history).toEqual(f.expected); expect(activity.delegates[0].history).toEqual([]);
    expect(activity.delegates[0].activity.readErrors).toEqual(["Session history is unavailable"]);
  }
  await writeFile(file,JSON.stringify({...original,agent_session_id:undefined}));
  await expect(f.runtime.history("delegate")).rejects.toThrow("different session");
  await db.prisma.runtimeSession.update({where:{id:"delegate"},data:{agentSessionId:null}});
  expect(await f.runtime.history("delegate")).toEqual(f.expected); // Existing records may lack this optional identity.
});

test("missing, corrupt and malformed saved history are errors, never successful empty history", async () => {
  const f=await fixture(), file=path.join(f.stateDir,"sessions","record-delegate.json"), original=JSON.parse(await readFile(file,"utf8"));
  for(const bytes of ["{",JSON.stringify({...original,schema:"unsupported"}),JSON.stringify({...original,messages:"broken"}),JSON.stringify({...original,messages:[{User:{id:"one",content:[{Text:42}]}}]})]) {
    await writeFile(file,bytes); await expect(f.runtime.history("delegate")).rejects.toThrow("corrupt");
    expect(await readFile(file,"utf8")).toBe(bytes);
  }
  await rm(file); await expect(f.runtime.history("delegate")).rejects.toThrow("unavailable");
  expect(await lstat(file).catch(()=>null)).toBeNull();
  await expect(f.runtime.history("unknown")).rejects.toThrow("not found");
  await db.prisma.runtimeSession.update({where:{id:"delegate"},data:{acpxRecordId:null}});
  await expect(f.runtime.history("delegate")).rejects.toThrow("identity is unavailable");
});

test("saved history refuses symlinks and oversized files without changing them", async () => {
  const f=await fixture(), file=path.join(f.stateDir,"sessions","record-delegate.json"), primary=path.join(f.stateDir,"sessions","record-primary.json");
  const bytes=await readFile(primary); await rm(file); await symlink(primary,file);
  await expect(f.runtime.history("delegate")).rejects.toThrow("unavailable"); expect(await readFile(primary)).toEqual(bytes);
  await rm(file); await writeFile(file,""); await truncate(file,64*1024*1024+1);
  await expect(f.runtime.history("delegate")).rejects.toThrow("unavailable"); expect((await lstat(file)).size).toBe(64*1024*1024+1);
});

test("activity retains bearer and exact closed task/delegate membership checks", async () => {
  const f=await fixture();
  const read=spyOn(f.runtime,"history");
  expect((await f.app.request("/api/tasks/task/activity",{headers:{authorization:"Bearer wrong"}})).status).toBe(401); expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  for(const [index,change] of [{cwd:"/foreign"},{repositoryId:"foreign"},{machineId:"foreign"},{role:"primary"}].entries()) {
    const id=`foreign-${index}`;
    await db.prisma.runtimeSession.create({data:{id,scopeKey:id,agentCommand:"codex",cwd:f.cwd,repositoryId:"repo",machineId:"machine",role:"delegate",status:"closed",closedAt:new Date(),...change}});
    await db.prisma.runtimeSessionRelation.create({data:{sourceSessionId:id,targetSessionId:"primary",relationship:"spawned-by"}});
  }
  const before=await unchangedState();
  let response=await f.app.request("/api/tasks/task/activity",{headers:f.headers}), value:any=await response.json();
  expect(value.delegates.map((d:any)=>d.session.id)).toEqual(["delegate"]); expect(value.delegates[0].history).toEqual(f.expected); expect(await unchangedState()).toEqual(before);
  await db.prisma.runtimeSessionRelation.updateMany({where:{sourceSessionId:"delegate"},data:{endedAt:new Date()}});
  response=await f.app.request("/api/tasks/task/activity",{headers:f.headers}); value=await response.json(); expect(value.delegates).toEqual([]);
  await db.prisma.runtimeSession.update({where:{id:"primary"},data:{repositoryId:"foreign"}});
  response=await f.app.request("/api/tasks/task/activity",{headers:f.headers}); value=await response.json(); expect(value.history).toEqual([]); expect(value.session).toBeNull();
});

test("history access does not reopen closed sessions or authorize new primary/delegate work", async () => {
  const f=await fixture(); await f.runtime.history("delegate"); const before=await unchangedState();
  const spawn=spyOn(Bun,"spawn").mockImplementation(()=>{throw Error("Closed session must never spawn");});
  try {
    for(const route of ["/api/tasks/task/instructions","/api/sessions/primary/delegates/delegate/instructions"]) {
      const response=await f.app.request(route,{method:"POST",headers:f.headers,body:JSON.stringify({requestKey:"denied",text:"new work"})}); expect(response.status).toBe(409);
    }
    await expect(f.runtime.enqueue({sessionId:"delegate",text:"new work",requestId:"denied"})).rejects.toThrow("closed");
    const turn=f.runtime.startTurn({sessionId:"delegate",text:"new work",requestId:"denied-turn"});
    expect(await turn.result).toMatchObject({status:"failed",error:"runtime session is closed: delegate"}); for await(const _ of turn.events){}
    expect(spawn).not.toHaveBeenCalled();
  } finally {spawn.mockRestore();}
  expect(await unchangedState()).toEqual(before); expect(await lstat(f.cwd).catch(()=>null)).toBeNull();
});

test("open sessions keep the existing history behavior", async () => {
  const f=await fixture(); await db.prisma.runtimeSession.update({where:{id:"delegate"},data:{status:"idle",closedAt:null}});
  expect(await f.runtime.history("delegate")).toEqual(f.expected);
  await db.prisma.runtimeSession.update({where:{id:"delegate"},data:{acpxRecordId:null}}); expect(await f.runtime.history("delegate")).toEqual([]);
});


test("growth during held read refuses without reading beyond the initial bounded size", async () => {
  const f = await fixture(), file = path.join(f.stateDir, "sessions", "record-delegate.json"), bytes = await readFile(file);
  const held = await open(file, "r"), prototype = Object.getPrototypeOf(held), read = prototype.read;
  let requested = 0, grown = false;
  const probe = spyOn(prototype, "read").mockImplementation(async function(this: any, ...args: any[]) {
    requested += args[2];
    if (!grown) { grown = true; await appendFile(file, " "); }
    return read.apply(this, args);
  });
  try { await expect(f.runtime.history("delegate")).rejects.toThrow("changed during read"); }
  finally { probe.mockRestore(); await held.close(); }
  expect(grown).toBe(true); expect(requested).toBe(bytes.length); expect((await lstat(file)).size).toBe(bytes.length + 1);
});
