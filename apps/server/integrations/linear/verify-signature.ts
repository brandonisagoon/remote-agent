import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify Linear's HMAC-SHA256 signature over the unparsed request body. */
export function verifyLinearSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
