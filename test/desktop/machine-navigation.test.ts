import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import example from "../../remote-agent.config.example.json";
import { configFilePath, parseServiceFile } from "../../lib/config.ts";
import { readConfigDocument, writeConfigDocument, type ConfigDocument } from "../../lib/config-file.ts";
import { withConfigFile } from "../../lib/config-scope.ts";
import { machineSidebarItems } from "../../lib/desktop-navigation.ts";
import { ConfigDraftController } from "../../apps/desktop/renderer/src/lib/config-draft.ts";
import type { HostDesktopApi } from "../../apps/desktop/shared.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(name: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "desktop-navigation-"));
  directories.push(directory);
  const file = path.join(directory, "config.json");
  const value = parseServiceFile(structuredClone(example));
  value.machine.id = name;
  value.machine.name = name;
  value.connections = {};
  value.repositories = { shared: { name: "Greenfield", root: `/${name}/greenfield`, worktreeRoot: `/${name}/worktrees`, worktreeNaming: { "*": "{branch}" } } };
  writeFileSync(file, JSON.stringify(value));
  return { file, document: readConfigDocument(file), value };
}

function controller(source: ReturnType<typeof fixture>, save?: (input: { expectedRevision: string; value: unknown }) => Promise<ConfigDocument>) {
  const api = {
    config: { save: save ?? (async (input) => writeConfigDocument({ file: source.file, ...input })) },
    repoConfigs: { save: async () => { throw new Error("Unexpected repository save"); } },
  } as unknown as HostDesktopApi;
  const config = new ConfigDraftController(api, () => {}, () => {}, () => {});
  config.receive(source.document);
  return config;
}

test("all-machine navigation retains colliding IDs, badges and the offline host's last received repositories", () => {
  const air = fixture("air");
  const pro = fixture("pro");
  const source = [
    { host: { id: "air", name: "MacBook Air", kind: "local" as const }, config: air.value, dirty: true, unavailable: true },
    { host: { id: "pro", name: "This Mac", kind: "local" as const }, config: pro.value, dirty: false, unavailable: false },
    { host: { id: "unreachable", name: "Unreachable", kind: "local" as const }, config: null, dirty: false, unavailable: true },
  ];
  const items = machineSidebarItems(source);
  const repos = items.filter((item) => item.kind === "repository");
  expect(repos.map(({ id, hostId, hostName, unavailable }) => ({ id, hostId, hostName, unavailable }))).toEqual([
    { id: "shared", hostId: "air", hostName: "MacBook Air", unavailable: true },
    { id: "shared", hostId: "pro", hostName: "This Mac", unavailable: false },
  ]);
  expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  expect(items.filter((item) => item.kind === "machine").map((item) => item.hostId)).toEqual(["air", "pro", "unreachable"]);
  expect(items.filter((item) => item.kind === "provider" && item.id === "codex").map((item) => item.hostId)).toEqual(["air", "pro"]);
});

test("navigating between hosts preserves separate drafts; saving one cannot save the other", async () => {
  const airSource = fixture("air"), proSource = fixture("pro");
  const air = controller(airSource), pro = controller(proSource);
  air.mutate((draft) => { draft.repositories.shared!.name = "Air edit"; });
  pro.mutate((draft) => { draft.repositories.shared!.name = "Pro edit"; });
  air.receive(readConfigDocument(airSource.file));
  expect(air.draft!.repositories.shared!.name).toBe("Air edit");
  await pro.save();
  expect(air.anyDirty).toBe(true);
  expect(pro.anyDirty).toBe(false);
  expect(readConfigDocument(airSource.file)).toEqual(airSource.document);
  const saved = readConfigDocument(proSource.file);
  expect(saved.valid && saved.value.repositories.shared!.name).toBe("Pro edit");
  air.revert();
  expect(air.draft!.repositories.shared!.name).toBe("Greenfield");
});

test("a pending save keeps its original host and retains newer edits when it completes", async () => {
  const airSource = fixture("air"), proSource = fixture("pro");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const air = controller(airSource, async (input) => { await pending; return writeConfigDocument({ file: airSource.file, ...input }); });
  const pro = controller(proSource);
  air.mutate((draft) => { draft.machine.name = "First edit"; });
  const saving = air.save();
  pro.mutate((draft) => { draft.machine.name = "Other host edit"; });
  air.mutate((draft) => { draft.machine.name = "Newer Air edit"; });
  release();
  await saving;
  expect(air.draft!.machine.name).toBe("Newer Air edit");
  expect(air.anyDirty).toBe(true);
  expect(pro.anyDirty).toBe(true);
  expect(readConfigDocument(proSource.file)).toEqual(proSource.document);
  await air.save();
  const saved = readConfigDocument(airSource.file);
  expect(saved.valid && saved.value.machine.name).toBe("Newer Air edit");
  expect(air.anyDirty).toBe(false);
});

test("failed saves keep the owning draft and reject stale revisions without overwriting disk changes", async () => {
  const source = fixture("air");
  const config = controller(source);
  config.mutate((draft) => { draft.machine.name = "My edit"; });
  writeConfigDocument({ file: source.file, expectedRevision: source.document.revision, value: { ...source.value, machine: { ...source.value.machine, name: "External edit" } } });
  await expect(config.save()).rejects.toThrow();
  config.receive(readConfigDocument(source.file));
  expect(config.externalChange).not.toBeNull();
  expect(config.draft!.machine.name).toBe("My edit");
  expect(config.saving).toBe(false);
  config.revert();
  expect(config.draft!.machine.name).toBe("External edit");
});

test("self-contained sidebar actions never silently commit an owner's pending edits", async () => {
  const source = fixture("air");
  const config = controller(source);
  config.mutate((draft) => { draft.machine.name = "Unfinished"; });
  await config.commit((draft) => { delete draft.providers.claude; });
  expect(config.anyDirty).toBe(true);
  expect(readConfigDocument(source.file)).toEqual(source.document);
});

test("overlapping local operations retain their own configuration after asynchronous boundaries", async () => {
  const air = fixture("air"), pro = fixture("pro");
  const prior = process.env.REMOTE_AGENT_CONFIG;
  const original = configFilePath();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const first = withConfigFile(air.file, async () => {
    expect(configFilePath()).toBe(air.file);
    await wait;
    expect(configFilePath()).toBe(air.file);
  });
  await withConfigFile(pro.file, async () => {
    expect(configFilePath()).toBe(pro.file);
    await Promise.resolve();
    release();
    await first;
    expect(configFilePath()).toBe(pro.file);
  });
  expect(configFilePath()).toBe(original);
  expect(process.env.REMOTE_AGENT_CONFIG).toBe(prior);
});
