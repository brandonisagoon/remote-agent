import type {
  BbClient,
  BbModel,
  BbProviderId,
} from "../../../types/runtime/index.ts";

export type ModelResolutionReason = "unknown" | "ambiguous";

export class ModelResolutionError extends Error {
  constructor(
    readonly requestedModel: string,
    readonly providerId: BbProviderId,
    readonly availableModelIds: string[],
    readonly reason: ModelResolutionReason,
  ) {
    super(
      `Cannot resolve model "${requestedModel}" for ${providerId} (${reason}). ` +
        `Available: ${availableModelIds.join(", ")}`,
    );
    this.name = "ModelResolutionError";
  }
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function tokens(value: string): string[] {
  return normalized(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function chooseCandidate(
  candidates: BbModel[],
  requested: string,
  providerId: BbProviderId,
  availableModelIds: string[],
): BbModel | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const defaults = candidates.filter((model) => model.isDefault);
  if (defaults.length === 1) return defaults[0];

  throw new ModelResolutionError(
    requested,
    providerId,
    availableModelIds,
    "ambiguous",
  );
}

/** Launch matching is intentionally stricter than ACP's display fallback: an
 * unknown launch model must not silently become the catalog default. */
export function matchCatalogModel(
  models: BbModel[],
  requested: string,
  providerId: BbProviderId,
): BbModel {
  const availableModelIds = models.map((model) => model.id);
  const requestedNormalized = normalized(requested);
  const exact = chooseCandidate(
    models.filter(
      (model) =>
        normalized(model.id) === requestedNormalized ||
        normalized(model.model) === requestedNormalized,
    ),
    requested,
    providerId,
    availableModelIds,
  );
  if (exact) return exact;

  const requestedTokens = tokens(requested);
  if (requestedTokens.length > 0) {
    const tokenMatches = chooseCandidate(
      models.filter((model) => {
        const modelTokens = new Set(tokens(`${model.id} ${model.model}`));
        return requestedTokens.every((token) => modelTokens.has(token));
      }),
      requested,
      providerId,
      availableModelIds,
    );
    if (tokenMatches) return tokenMatches;
  }

  throw new ModelResolutionError(
    requested,
    providerId,
    availableModelIds,
    "unknown",
  );
}

export async function resolveLaunchModel(input: {
  bbClient: Pick<BbClient, "listModels">;
  providerId: BbProviderId;
  hostId?: string;
  requested?: string;
}): Promise<string | undefined> {
  if (input.requested === undefined) return undefined;

  let models: BbModel[];
  try {
    models = await input.bbClient.listModels({
      providerId: input.providerId,
      hostId: input.hostId,
    });
  } catch (error) {
    console.warn(
      `[launches] model catalog unavailable for ${input.providerId}@${input.hostId ?? "default"}; ` +
        `passing model "${input.requested}" through unresolved`,
      error,
    );
    return input.requested;
  }

  if (models.length === 0) {
    console.warn(
      `[launches] model catalog unavailable for ${input.providerId}@${input.hostId ?? "default"}; ` +
        `passing model "${input.requested}" through unresolved`,
    );
    return input.requested;
  }

  return matchCatalogModel(models, input.requested, input.providerId).id;
}
