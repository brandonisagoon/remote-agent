import type { PrismaClient } from "../../../generated/prisma/client.ts";
import type {
  RepositoryConfig,
  ServerConfig,
  LabelGroupConfig,
} from "../../config.ts";
import { getRepositoryConfig } from "../../config.ts";

export interface ResolvedSessionLabel {
  key: string;
  value: string;
  source: string;
}

function definitionFor(
  repository: RepositoryConfig,
  key: string,
): LabelGroupConfig {
  const definition = repository.labels[key];
  if (!definition) {
    throw new Error(`unknown tag for repository ${repository.id}: ${key}`);
  }
  return definition;
}

function validateValues(
  repository: RepositoryConfig,
  key: string,
  values: readonly string[],
): string[] {
  const definition = definitionFor(repository, key);
  const normalized = [...new Set(values.map((value) => value.trim()))];
  if (normalized.some((value) => value.length === 0)) {
    throw new Error(`tag ${key} contains an empty value`);
  }
  if (definition.exclusive && normalized.length > 1) {
    throw new Error(`tag ${key} accepts only one value`);
  }
  if (definition.labels) {
    for (const value of normalized) {
      if (!definition.labels.includes(value)) {
        throw new Error(
          `tag ${key} value is not configured for repository ${repository.id}: ${value}`,
        );
      }
    }
  }
  return normalized;
}

/** Resolve repository defaults and explicit launch values deterministically. */
export function resolveInitialSessionLabels(
  repository: RepositoryConfig,
  explicit: Readonly<Record<string, readonly string[]>> = {},
): ResolvedSessionLabel[] {
  const values = new Map<string, Map<string, string>>();
  for (const [key, defaults] of Object.entries(repository.sessionDefaults.labels)) {
    values.set(
      key,
      new Map(validateValues(repository, key, defaults).map((value) => [value, "config-default"])),
    );
  }
  for (const [key, requested] of Object.entries(explicit)) {
    const definition = definitionFor(repository, key);
    const validated = validateValues(repository, key, requested);
    const current = definition.exclusive
      ? new Map<string, string>()
      : (values.get(key) ?? new Map<string, string>());
    for (const value of validated) current.set(value, "launch");
    values.set(key, current);
  }
  return [...values.entries()]
    .flatMap(([key, entries]) => [...entries.entries()].map(([value, source]) => ({
      key,
      value,
      source,
    })))
    .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
}

export async function readSessionLabels(
  prisma: PrismaClient,
  runtimeSessionId: string,
): Promise<{ revision: number; tags: Record<string, string[]> }> {
  const session = await prisma.runtimeSession.findUnique({
    where: { id: runtimeSessionId },
    select: {
      metadataRevision: true,
      tags: { orderBy: [{ key: "asc" }, { value: "asc" }] },
    },
  });
  if (!session) throw new Error(`runtime session not found: ${runtimeSessionId}`);
  const tags: Record<string, string[]> = {};
  for (const tag of session.tags) (tags[tag.key] ??= []).push(tag.value);
  return { revision: session.metadataRevision, tags };
}

export async function setSessionLabel(
  prisma: PrismaClient,
  config: ServerConfig,
  input: {
    runtimeSessionId: string;
    key: string;
    values: string[];
    source: string;
    expectedRevision?: number;
  },
): Promise<{ revision: number; tags: Record<string, string[]> }> {
  const session = await prisma.runtimeSession.findUnique({
    where: { id: input.runtimeSessionId },
    select: { repositoryId: true, metadataRevision: true },
  });
  if (!session) throw new Error(`runtime session not found: ${input.runtimeSessionId}`);
  const repository = getRepositoryConfig(config, session.repositoryId);
  definitionFor(repository, input.key);
  const values = validateValues(repository, input.key, input.values);
  const expectedRevision = input.expectedRevision ?? session.metadataRevision;

  await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.runtimeSession.updateMany({
      where: { id: input.runtimeSessionId, metadataRevision: expectedRevision },
      data: { metadataRevision: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("session metadata revision conflict");
    await transaction.runtimeSessionTag.deleteMany({
      where: { runtimeSessionId: input.runtimeSessionId, key: input.key },
    });
    for (const value of values) {
      await transaction.runtimeSessionTag.upsert({
        where: {
          runtimeSessionId_key_value: {
            runtimeSessionId: input.runtimeSessionId,
            key: input.key,
            value,
          },
        },
        create: {
          runtimeSessionId: input.runtimeSessionId,
          key: input.key,
          value,
          source: input.source,
        },
        update: { source: input.source },
      });
      await transaction.runtimeMetadataEvent.create({
        data: {
          runtimeSessionId: input.runtimeSessionId,
          action: "set",
          key: input.key,
          value,
          source: input.source,
        },
      });
    }
  });
  return readSessionLabels(prisma, input.runtimeSessionId);
}

export async function removeSessionLabel(
  prisma: PrismaClient,
  config: ServerConfig,
  input: {
    runtimeSessionId: string;
    key: string;
    value?: string;
    source: string;
    expectedRevision?: number;
  },
): Promise<{ revision: number; tags: Record<string, string[]> }> {
  const session = await prisma.runtimeSession.findUnique({
    where: { id: input.runtimeSessionId },
    select: { repositoryId: true, metadataRevision: true },
  });
  if (!session) throw new Error(`runtime session not found: ${input.runtimeSessionId}`);
  definitionFor(getRepositoryConfig(config, session.repositoryId), input.key);
  const expectedRevision = input.expectedRevision ?? session.metadataRevision;
  await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.runtimeSession.updateMany({
      where: { id: input.runtimeSessionId, metadataRevision: expectedRevision },
      data: { metadataRevision: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("session metadata revision conflict");
    await transaction.runtimeSessionTag.deleteMany({
      where: {
        runtimeSessionId: input.runtimeSessionId,
        key: input.key,
        ...(input.value === undefined ? {} : { value: input.value }),
      },
    });
    await transaction.runtimeMetadataEvent.create({
      data: {
        runtimeSessionId: input.runtimeSessionId,
        action: "remove",
        key: input.key,
        value: input.value,
        source: input.source,
      },
    });
  });
  return readSessionLabels(prisma, input.runtimeSessionId);
}
