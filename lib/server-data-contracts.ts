/** Persisted/wire contracts implemented by this server, independent of the
 * SQL schema and the general tooling operation protocol. Keep the deployment
 * marker aligned: older readers must refuse before service changes. */
export const SERVER_DATA_CONTRACTS = ["task-publication/v1", "clerk-assignment/v1", "configuration-completion/v1", "runtime-health/v1", "capability-publication/v1"] as const;
export function assertServerDataContracts(required: readonly string[] = []) {
  const missing = required.filter(value => !(SERVER_DATA_CONTRACTS as readonly string[]).includes(value));
  if (missing.length) throw new Error("Server does not support required saved-data contracts: " + missing.join(", "));
}
