import type { ServiceFile } from "./config.ts";

/** Removing a repository must never expand a connection's permissions. */
export function removeRepository(file: ServiceFile, repositoryId: string) {
  delete file.repositories[repositoryId];
  for (const connection of Object.values(file.connections)) {
    if (connection.repositories !== "*") delete connection.repositories[repositoryId];
  }
}
