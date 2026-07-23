import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Second-factor passcode for the admin console. After a correct username +
// password, the operator must also enter a 6-digit passcode before an admin
// session is issued. Passcodes are hashed with the same scrypt scheme as
// admin passwords (see admin-auth.ts) so a database leak never exposes them.
//
// This module is intentionally free of `server-only` and of any Supabase or
// env access so it can be unit-tested in isolation. The DB/env wiring lives in
// admin-auth.ts.

export const ADMIN_PASSCODE_LENGTH = 6;

const PASSCODE_PATTERN = /^\d{6}$/;

/** Strips everything but digits (handles spaces/dashes a user might type). */
export function normalizePasscode(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** True only for an exactly-6-digit numeric passcode. */
export function isValidPasscodeFormat(passcode: string): boolean {
  return PASSCODE_PATTERN.test(passcode);
}

/** Derives a scrypt hash (hex) for a passcode + salt. */
export function hashPasscode(passcode: string, salt: string): string {
  return scryptSync(passcode, salt, 64).toString("hex");
}

/** Generates a fresh random salt for a new passcode. */
export function generatePasscodeSalt(): string {
  return randomBytes(16).toString("hex");
}

/** Constant-time verification of a passcode against a stored salt + hash. */
export function verifyPasscodeHash(passcode: string, salt: string, hashHex: string): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  const derived = scryptSync(passcode, salt, 64);
  if (expected.length !== derived.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

/** Constant-time comparison of two passcode strings (for the env fallback). */
export function constantTimeEqualString(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export type PasscodeCheckResult = "ok" | "invalid" | "not_configured";

/**
 * Resolves a passcode against a per-account hash, falling back to a global
 * environment access code when no per-account passcode is set.
 *
 * Returns:
 *  - "ok"             passcode matched a configured factor
 *  - "invalid"        a factor is configured but the passcode did not match
 *  - "not_configured" no per-account passcode and no ADMIN_ACCESS_CODE set;
 *                     the caller decides how to handle an un-provisioned factor
 *                     (we allow login so a fresh deployment is never locked out)
 */
export function resolvePasscodeCheck(input: {
  passcodeRaw: string;
  accountSalt: string | null | undefined;
  accountHash: string | null | undefined;
  envAccessCode: string | null | undefined;
}): PasscodeCheckResult {
  const passcode = normalizePasscode(input.passcodeRaw);

  if (input.accountHash && input.accountSalt) {
    if (!isValidPasscodeFormat(passcode)) {
      return "invalid";
    }
    return verifyPasscodeHash(passcode, input.accountSalt, input.accountHash) ? "ok" : "invalid";
  }

  const envCode = (input.envAccessCode ?? "").trim();
  if (isValidPasscodeFormat(envCode)) {
    if (!isValidPasscodeFormat(passcode)) {
      return "invalid";
    }
    return constantTimeEqualString(passcode, envCode) ? "ok" : "invalid";
  }

  return "not_configured";
}
