import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";

test("browser-control migration preserves only explicit owner pauses and keeps task identities", () => {
  const db = new Database(":memory:");
  try {
    db.exec('CREATE TABLE RemoteTask (id TEXT PRIMARY KEY, phase TEXT, controlMode TEXT, controllerId TEXT, controlGeneration INTEGER, toolingRevision TEXT)');
    const insert = db.prepare("INSERT INTO RemoteTask VALUES (?, ?, ?, ?, 5, 'same-pin')");
    insert.run("owner", "review", "paused", "task-supervisor:owner");
    insert.run("pausing", "working", "draining", "task-supervisor:pausing");
    insert.run("viewer", "working", "paused", "browser-viewer");
    insert.run("active", "working", "agent", null);
    insert.run("closed", "closed", "paused", "task-supervisor:closed");
    db.exec(readFileSync(path.join(import.meta.dir, "../../../../prisma/migrations/20261029020000_remove_browser_task_control/migration.sql"), "utf8"));
    expect(db.query("SELECT id, ownerPaused FROM RemoteTask ORDER BY id").all()).toEqual([
      { id: "active", ownerPaused: 0 }, { id: "closed", ownerPaused: 0 }, { id: "owner", ownerPaused: 1 }, { id: "pausing", ownerPaused: 1 }, { id: "viewer", ownerPaused: 0 },
    ]);
    expect(db.query("SELECT phase, toolingRevision FROM RemoteTask WHERE id = 'owner'").get()).toEqual({ phase: "review", toolingRevision: "same-pin" });
    const columns = db.query("PRAGMA table_info(RemoteTask)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("controlMode");
    expect(columns.map((column) => column.name)).not.toContain("controllerId");
    expect(columns.map((column) => column.name)).not.toContain("controlGeneration");
  } finally { db.close(); }
});
