import { afterEach, expect, test } from "bun:test";
import { testConfig } from "../../../../../test-support/config.ts";
import { completeLinearRouting } from "./routing.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("missing team metadata is resolved only for the allowed actor and organization", async () => {
  const config = testConfig();
  const webhook = { ...config.webhooks[config.activeWebhookId]!, repositoryRouting: { [config.repository.id]: { when: [{ "linear.organizationId": ["org"], "linear.userId": ["owner"], "linear.teamId": ["team"] }] } } };
  let calls = 0;
  let organization = "org";
  globalThis.fetch = (async () => { calls++; return Response.json({ data: { issue: { team: { id: "team", key: "DRA", organization: { id: organization } }, project: null } } }); }) as unknown as typeof fetch;
  for (const actor of [undefined, "other", config.agentUserId]) {
    const attributes = { "linear.organizationId": "org", "linear.userId": actor };
    expect(await completeLinearRouting(config, webhook, attributes, "issue")).toEqual(attributes);
  }
  expect(calls).toBe(0);
  const owner = { "linear.organizationId": "org", "linear.userId": "owner" };
  expect((await completeLinearRouting(config, webhook, owner, "issue"))["linear.teamId"]).toBe("team");
  expect(calls).toBe(1);
  organization = "wrong-org";
  expect(await completeLinearRouting(config, webhook, owner, "issue")).toEqual(owner);
});
