const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

interface LinearGraphqlError {
  message: string;
}

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: LinearGraphqlError[];
}

export class LinearApiError extends Error {}

/**
 * Minimal Linear GraphQL client, mirroring
 * apps/api/src/lib/services/linear/client.ts. Note Linear takes the raw API key
 * in Authorization with no `Bearer` prefix.
 *
 * Duplicated rather than imported because this app deliberately has no
 * @cubic/* workspace dependencies — it must install standalone in the deploy.
 */
export async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LinearApiError(
      `Linear HTTP ${response.status}: ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const payload = (await response.json()) as LinearGraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new LinearApiError(payload.errors.map((e) => e.message).join("; "));
  }
  if (!payload.data) throw new LinearApiError("Linear returned no data");

  return payload.data;
}
