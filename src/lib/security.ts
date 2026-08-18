import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify Linear's HMAC-SHA256 signature over the RAW request body.
 *
 * Must run against the unparsed body string: re-serializing the JSON would
 * change key order and whitespace, and the signature would never match.
 */
export function verifyLinearSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return safeEqual(expected, received);
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

function bbThreadLinkDigest(threadId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`bb-thread-open:v1:${threadId}`)
    .digest();
}

export function signBbThreadLink(threadId: string, secret: string): string {
  return bbThreadLinkDigest(threadId, secret).toString("hex");
}

export function verifyBbThreadLink(
  threadId: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return safeEqual(
    bbThreadLinkDigest(threadId, secret),
    Buffer.from(signature, "hex"),
  );
}
