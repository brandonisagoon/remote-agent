import path from "node:path";
import { z } from "zod";

const Descriptor = z.union([z.string().regex(/^\d{1,10}$/), z.enum(["cwd", "rtd", "txt", "mem", "mmap", "pd", "err", "other"])]);
const Type = z.enum(["DIR", "REG", "FIFO", "CHR", "BLK", "LINK", "SOCK", "IPv4", "IPv6", "unix", "KQUEUE", "PSXSEM", "PSXSHM", "NPOLICY", "NEXUS", "PIPE", "systm", "unknown", "UNKN", "missing", "other"]);
export const FilesystemHandleDiagnostic = z.object({
  processId: z.number().int().positive().max(2_147_483_647), descriptor: Descriptor, type: Type,
  problem: z.enum(["missing-type", "unknown-type", "missing-name", "nonabsolute-path"]),
  name: z.enum(["missing", "absolute", "nonabsolute"]),
}).strict().refine(value => value.problem === "missing-type" ? value.type === "missing"
  : value.problem === "unknown-type" ? ["unknown", "UNKN"].includes(value.type)
  : value.problem === "missing-name" ? value.name === "missing" && !["missing", "unknown", "UNKN", "NPOLICY", "NEXUS", "PIPE"].includes(value.type)
  : ["DIR", "REG"].includes(value.type) && value.name === "nonabsolute", "Handle classification does not match its refused observation");
export type FilesystemHandleDiagnostic = z.infer<typeof FilesystemHandleDiagnostic>;

export function filesystemHandleReason(value: FilesystemHandleDiagnostic) {
  return `An open filesystem handle could not be identified (process ${value.processId}, descriptor ${JSON.stringify(value.descriptor)}, type ${JSON.stringify(value.type)}, ${value.problem}, name ${value.name}); absence is unverified`;
}
export class FilesystemHandleDiagnosticError extends Error {
  readonly handle: FilesystemHandleDiagnostic;
  constructor(handle: FilesystemHandleDiagnostic) {
    const checked = FilesystemHandleDiagnostic.parse(handle);
    super(filesystemHandleReason(checked));
    this.handle = Object.freeze(checked);
  }
}

/** Preserve only enumerated classifications. Never retain the pathname,
 * command, raw descriptor/type text, lsof record, stack or exception cause. */
export function unidentifiedFilesystemHandle(processId: number, current: { descriptor: string; type?: string; name?: string }) {
  return new FilesystemHandleDiagnosticError({
    processId, descriptor: Descriptor.safeParse(current.descriptor).data ?? "other", type: Type.safeParse(current.type || "missing").data ?? "other",
    problem: !current.type ? "missing-type" : ["unknown", "UNKN"].includes(current.type) ? "unknown-type" : !current.name ? "missing-name" : "nonabsolute-path",
    name: !current.name ? "missing" : path.isAbsolute(current.name) ? "absolute" : "nonabsolute",
  });
}
