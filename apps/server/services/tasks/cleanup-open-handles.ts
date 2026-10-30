import path from "node:path";
import { assertFinalizationPath } from "./finalization-resources.ts";

const MAX_BYTES = 8 * 1024 * 1024;
type Result = { exitCode: number | null; stdout: Buffer; stderr: Buffer; signalCode?: string | null };
export type HandleCommand = (command: string[]) => Result;
const command: HandleCommand = command => Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, maxBuffer: MAX_BYTES });
const contains = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`) || file === `${root} (deleted)`;
// Darwin exposes these as distinct kernel descriptor types, not vnodes:
// apple-oss-distributions/xnu bsd/sys/proc_info.h (PROX_FDTYPE_*).
// lsof's Darwin process_pipe_common also deliberately omits NAME for a pipe
// with no peer/count. A missing filesystem pathname remains an error.
const NAMELESS_KERNEL_HANDLES = new Set(["NPOLICY", "NEXUS", "PIPE"]);

/** Enumerate open handles once instead of recursively walking installed files.
 * No process/descriptor is exempted. NUL fields preserve spaces and newlines. */
export function assertRootHandleInventory(root: string, output: Buffer) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || output.length === 0 || output.length > MAX_BYTES || !output.includes(0)) throw new Error("Root handle inventory is invalid or incomplete");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(output);
  let processId = 0, files = 0, current: { type?: string; name?: string } | undefined;
  const finish = () => {
    if (!current) return;
    if (!current.type || !current.name && !NAMELESS_KERNEL_HANDLES.has(current.type) || ["unknown", "UNKN"].includes(current.type)
      || ["DIR", "REG"].includes(current.type) && (!current.name || !path.isAbsolute(current.name))) throw new Error("An open filesystem handle could not be identified");
    if (current.name && contains(root, current.name)) throw new Error("A process still holds the linked worktree or its retained capture");
    files++; current = undefined;
  };
  for (const token of value.split("\0")) {
    const field = token.startsWith("\n") ? token.slice(1) : token;
    if (!field) continue;
    if (field[0] === "p") {
      finish(); if (!/^[1-9]\d*$/.test(field.slice(1))) throw new Error("Root handle process identity is malformed"); processId = Number(field.slice(1));
    } else if (field[0] === "f") {
      finish(); if (!processId || !field.slice(1)) throw new Error("Root handle descriptor identity is malformed"); current = {};
    } else if (field[0] === "t") {
      if (!current || current.type) throw new Error("Root handle type is malformed"); current.type = field.slice(1);
    } else if (field[0] === "n") {
      if (!current || current.name) throw new Error("Root handle name is malformed"); current.name = field.slice(1);
    } else throw new Error("Unexpected root handle inventory field");
  }
  finish(); if (!processId || !files) throw new Error("Root handle inventory is incomplete");
}

export async function assertLinkedRootIdle(root: string, run: HandleCommand = command) {
  return assertLinkedPathsIdle([root], run);
}

/** One bounded process/handle snapshot covers a prepared set of exact files. */
export async function assertLinkedPathsIdle(roots: string[], run: HandleCommand = command) {
  if (!roots.length || roots.length > 2000 || new Set(roots).size !== roots.length) throw new Error("Filesystem observation scope is invalid");
  for (const root of roots) await assertFinalizationPath(root);
  const processes = run(["ps", "-axo", "pid=,command="]);
  if (processes.exitCode !== 0 || processes.signalCode || processes.stderr.length || !processes.stdout.length || processes.stdout.length > MAX_BYTES) throw new Error("Linked worktree process inspection failed");
  if (processes.stdout.toString().split("\n").some(line => roots.some(root => line.includes(root)))) throw new Error("A process command still references the linked worktree");
  const handles = run(["lsof", "-nP", "-F0pftn"]);
  if (handles.exitCode !== 0 || handles.signalCode || handles.stderr.length || handles.stdout.length > MAX_BYTES) throw new Error("Linked worktree open-handle inspection failed; absence is unverified");
  for (const root of roots) assertRootHandleInventory(root, handles.stdout);
  for (const root of roots) await assertFinalizationPath(root);
}
