import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
