import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import type { Client, Config, InArgs, InStatement } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const MAX_RECORDS = 2_000;
const MAX_BYTES = 512 * 1024;

/** One process-wide, finite diagnostic window. Never includes SQL or values. */
export function createDatabaseDiagnostic(
  seconds: string | undefined,
  write: (line: string) => void = (line) => { writeSync(2, line); },
  now: () => number = () => performance.now(),
) {
  const duration = seconds && /^[1-9]\d{0,2}$/.test(seconds) ? Number(seconds) : 0;
  const deadline = duration > 0 && duration <= 300 ? now() + duration * 1000 : 0;
  let records = 0;
  let bytes = 0;
  let sequence = 0;

  function emit(record: object): void {
    if (!deadline || now() >= deadline || records >= MAX_RECORDS) return;
    const line = JSON.stringify({ diagnostic: "libsql-operation", ...record }) + "\n";
    const size = Buffer.byteLength(line);
    if (bytes + size > MAX_BYTES) return;
    records++;
    bytes += size;
    // Diagnostic sink failures must not replace database results or errors.
    try { write(line); } catch { /* Only the diagnostic write is best effort. */ }
  }

  return function run<T>(operation: "execute" | "executeMultiple", sql: string, argumentCount: number, invoke: () => Promise<T>): Promise<T> {
    if (!deadline || now() >= deadline || records >= MAX_RECORDS || bytes >= MAX_BYTES) return invoke();
    const id = ++sequence;
    const fingerprint = createHash("sha256").update(sql).digest("hex");
    const started = now();
    emit({ id, operation, fingerprint, argumentCount, phase: "start" });
    // Invoke only after the synchronous start write, including for native stalls.
    try {
      return invoke().then(
        (value) => {
          emit({ id, phase: "finish", durationMs: now() - started, outcome: "ok" });
          return value;
        },
        (error: unknown) => {
          emit({ id, phase: "finish", durationMs: now() - started, outcome: "error" });
          throw error;
        },
      );
    } catch (error) {
      emit({ id, phase: "finish", durationMs: now() - started, outcome: "error" });
      throw error;
    }
  };
}

let diagnostic: ReturnType<typeof createDatabaseDiagnostic> | undefined;

/** The pinned file adapter uses this client for queries and transaction control. */
export class DiagnosticPrismaLibSql extends PrismaLibSql {
  override createClient(config: Config): Client {
    const client = super.createClient(config);
    const seconds = process.env.REMOTE_AGENT_DB_DIAGNOSTIC_SECONDS;
    if (!seconds || !/^[1-9]\d{0,2}$/.test(seconds) || Number(seconds) > 300) return client;
    const run = diagnostic ??= createDatabaseDiagnostic(seconds);
    const execute = client.execute;
    client.execute = (...parameters: [statement: InStatement] | [sql: string, args?: InArgs]) => {
      const [statement, positionalArgs] = parameters;
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = typeof statement === "string" ? positionalArgs : statement.args;
      return run("execute", sql, args ? Object.keys(args).length : 0,
        () => Reflect.apply(execute, client, parameters) as ReturnType<Client["execute"]>);
    };
    const executeMultiple = client.executeMultiple.bind(client);
    client.executeMultiple = (sql) => run("executeMultiple", sql, 0, () => executeMultiple(sql));
    return client;
  }
}
