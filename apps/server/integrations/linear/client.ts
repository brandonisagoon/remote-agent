import type { LinearCredential } from "../../../../lib/linear-auth.ts";
import { linearAppAuth } from "./app-auth.ts";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

interface LinearGraphqlError {
  message: string;
}

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: LinearGraphqlError[];
}

export class LinearApiError extends Error {}

/** Keep structured failures for narrowly scoped read reconciliation. Private
 * storage avoids adding provider payloads to ordinary Error logging/JSON. */
export class LinearGraphqlResponseError extends LinearApiError {
  #response: { errors: LinearGraphqlError[]; data: unknown };
  constructor(errors: LinearGraphqlError[], data: unknown) {
    super(errors.map(error => error.message).join("; "));
    this.#response = { errors, data };
  }
  get response() { return this.#response; }
}

/** Personal keys use a raw Authorization header; apps use renewable bearer
 * tokens. Only an explicit HTTP 401 permits one retry, never an ambiguous
 * mutation failure or a network timeout. */
export async function linearGraphql<T>(
  apiKey: LinearCredential,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const send = (authorization: string) => fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({ query, variables }),
  });
  const authorization = await linearAppAuth.authorization(apiKey);
  let response = await send(authorization);
  if (response.status === 401 && typeof apiKey !== "string") {
    await response.body?.cancel();
    linearAppAuth.reject(apiKey, authorization);
    response = await send(await linearAppAuth.authorization(apiKey));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LinearApiError(
      `Linear HTTP ${response.status}: ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const payload = (await response.json()) as LinearGraphqlResponse<T>;
  if (payload.errors?.length) {
    throw new LinearGraphqlResponseError(payload.errors, payload.data);
  }
  if (!payload.data) throw new LinearApiError("Linear returned no data");

  return payload.data;
}
