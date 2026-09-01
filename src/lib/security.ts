import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify GitHub's `x-hub-signature-256` header (`sha256=<hex>`). */
export function verifyGithubSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;

  const hex = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return safeEqual(expected, Buffer.from(hex, "hex"));
}

/**
 * Verify a bearer token.
 *
 * Both sides are hashed before comparison so the comparison length is constant
 * regardless of the supplied token — otherwise a length check would leak the
 * expected token's size.
 */
export function verifyBearerToken(
  authorization: string | null,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;

  const received = authorization.slice("Bearer ".length);
  return safeEqual(
    createHash("sha256").update(received).digest(),
    createHash("sha256").update(expectedToken).digest(),
  );
}
