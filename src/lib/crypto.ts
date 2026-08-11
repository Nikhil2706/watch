import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 32 bytes of CSPRNG output, base64url encoded (43 chars, URL/chat safe). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Opaque session identifier. Same entropy budget as an invite token. */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** Primary keys. UUIDv4 rather than autoincrement so ids are safe to paste. */
export function generateId(): string {
  return randomUUID();
}

/** Lowercase hex SHA-256. Used for invite token storage and key comparison. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, and the lengths themselves would
 * leak through that throw. Hashing both sides first makes every comparison
 * operate on two fixed 32-byte buffers, so neither the length nor the content
 * of the supplied value affects how long this takes.
 *
 * This is what guards ADMIN_API_KEY: without it, an attacker could recover the
 * key one byte at a time by measuring response latency.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
