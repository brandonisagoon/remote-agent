import { z } from "zod";

/** Existing personal keys stay valid. App credentials mint short-lived bearer
 * tokens in the server; access tokens are never saved as configuration. */
export const LinearCredentialSchema = z.union([
  z.string().min(1),
  z.object({
    type: z.literal("app"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  }).strict(),
]);

export type LinearCredential = z.infer<typeof LinearCredentialSchema>;
export type LinearAppCredential = Exclude<LinearCredential, string>;
