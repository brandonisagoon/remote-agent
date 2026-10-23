import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import example from "../remote-agent.config.example.json";
import { readConfig } from "./config.ts";
import { withConfigFile } from "./config-scope.ts";
import { runChecks } from "../management/checks.ts";
import { readConfigDocument, writeConfigDocument } from "./config-file.ts";

describe("config file documents", () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("writes validated JSON atomically and rejects stale UI state", () => {
    directory = mkdtempSync(path.join(tmpdir(), "remote-agent-config-file-"));
    const file = path.join(directory, "remote-agent.config.json");
    writeFileSync(file, JSON.stringify(example));
    const initial = readConfigDocument(file);
    expect(initial.valid).toBe(true);
    if (!initial.valid) throw new Error(initial.error);

    const value = structuredClone(initial.value);
    value.machine.name = "Edited Machine";
    const saved = writeConfigDocument({
      file,
      expectedRevision: initial.revision,
      value,
    });
    expect(saved.valid && saved.value.machine.name).toBe("Edited Machine");
    expect(readFileSync(file, "utf8")).toEndWith("\n");
    expect(() => writeConfigDocument({
      file,
      expectedRevision: initial.revision,
      value,
    })).toThrow("config changed on disk");
  });

  test("surfaces an external invalid edit without replacing it", () => {
    directory = mkdtempSync(path.join(tmpdir(), "remote-agent-config-file-"));
    const file = path.join(directory, "remote-agent.config.json");
    writeFileSync(file, "{broken");
    const document = readConfigDocument(file);
    expect(document.valid).toBe(false);
    expect(document.raw).toBe("{broken");
  });

  test("a machine can save no repositories, stay editable, and add one later", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "remote-agent-config-file-"));
    const file = path.join(directory, "remote-agent.config.json");
    writeFileSync(file, JSON.stringify(example));
    const initial = readConfigDocument(file);
    if (!initial.valid) throw new Error(initial.error);
    const value = structuredClone(initial.value);
    value.repositories = {};
    for (const connection of Object.values(value.connections)) connection.repositories = "*";
    const saved = writeConfigDocument({ file, expectedRevision: initial.revision, value });
    expect(saved.valid && saved.value.repositories).toEqual({});
    expect(() => readConfig(file)).toThrow("Add a repository before starting this machine's server");

    const checks = await withConfigFile(file, runChecks);
    expect(checks.find((check) => check.id === "config")?.status).toBe("ok");
    expect(checks.find((check) => check.id === "repositories")).toMatchObject({ status: "warn", detail: "No repositories configured" });
    expect(checks.some((check) => check.id === "server")).toBe(false);

    value.repositories = initial.value.repositories;
    const restored = writeConfigDocument({ file, expectedRevision: saved.revision, value });
    expect(restored.valid).toBe(true);
    expect(Object.keys(readConfig(file).repositories)).toEqual(Object.keys(value.repositories));
  });
});
