import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// SEALING FOR CONTROL-STORE SECRETS.
//
// The Control Center and Settings pages keep every setting — including the
// SMTP password, the Resend / SendGrid API keys, the processor secret and
// webhook keys, and the Pushover credentials — as rows in admin_audit_logs.
// That store is append-only and is read by every admin who can open the audit
// trail, by database exports, and by anyone holding a service-role key. The
// UI redacts on the way out, but the row itself held the credential in clear.
//
// This seals a secret VALUE before it is written and unseals it on read, with
// AES-256-GCM under a key that lives only in the server environment
// (ADMIN_CONTROL_SECRET_KEY, 32 bytes as 64 hex chars or base64). The audit row
// then carries `sealed:v1:<base64 iv|tag|ciphertext>` and is useless without
// the environment.
//
// WITHOUT THE KEY NOTHING CHANGES. A missing key writes the value exactly as
// before and reads it back exactly as before, so an environment that has not
// been given the key keeps working — and says so once in the logs. A sealed
// value read without the key (the key was removed after sealing) is the one
// case that cannot be honoured: it unseals to "" and is reported, because
// silently returning ciphertext to the SMTP client is worse than a visible
// outage.
// ---------------------------------------------------------------------------

const PREFIX = "sealed:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let warnedMissingKey = false;
let warnedBadKey = false;

/** The 32-byte sealing key from the environment, or null when unset/invalid. */
export function readSealingKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = String(env.ADMIN_CONTROL_SECRET_KEY ?? "").trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  if (!warnedBadKey) {
    warnedBadKey = true;
    console.error("[control-secrets] ADMIN_CONTROL_SECRET_KEY is set but is not 32 bytes (64 hex chars or base64); secrets are NOT being sealed.");
  }
  return null;
}

/** Whether the sealing key is available to this process. */
export function sealingAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return readSealingKey(env) !== null;
}

export function isSealedControlValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Seal a secret for storage. Non-strings, empty strings and already-sealed
 * values pass through untouched; so does everything when no key is configured.
 */
export function sealControlSecret(value: unknown, env: Record<string, string | undefined> = process.env): unknown {
  if (typeof value !== "string" || value === "" || isSealedControlValue(value)) return value;
  const key = readSealingKey(env);
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn("[control-secrets] ADMIN_CONTROL_SECRET_KEY is not set; a credential was stored in clear text. Set the key to seal control-store secrets at rest.");
    }
    return value;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export type UnsealOutcome =
  | { ok: true; value: unknown }
  | { ok: false; value: ""; reason: "no_key" | "corrupt" };

/** Unseal a stored value. Plain values (legacy rows) pass through untouched. */
export function unsealControlSecretDetailed(value: unknown, env: Record<string, string | undefined> = process.env): UnsealOutcome {
  if (!isSealedControlValue(value)) return { ok: true, value };
  const key = readSealingKey(env);
  if (!key) return { ok: false, value: "", reason: "no_key" };
  try {
    const packed = Buffer.from(value.slice(PREFIX.length), "base64");
    if (packed.length < IV_BYTES + TAG_BYTES + 1) return { ok: false, value: "", reason: "corrupt" };
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return { ok: true, value: plain };
  } catch {
    return { ok: false, value: "", reason: "corrupt" };
  }
}

/**
 * Unseal for a reader that only wants the value. A sealed value that cannot be
 * opened becomes "" and is logged once per reason — never handed on as
 * ciphertext.
 */
const reported = new Set<string>();
export function unsealControlSecret(value: unknown, env: Record<string, string | undefined> = process.env): unknown {
  const outcome = unsealControlSecretDetailed(value, env);
  if (outcome.ok) return outcome.value;
  if (!reported.has(outcome.reason)) {
    reported.add(outcome.reason);
    console.error(
      outcome.reason === "no_key"
        ? "[control-secrets] A sealed credential was read but ADMIN_CONTROL_SECRET_KEY is not set in this environment; the integration that needs it will fail until the key is restored."
        : "[control-secrets] A sealed credential could not be opened (wrong key or corrupt row); re-enter it in Admin -> Settings.",
    );
  }
  return outcome.value;
}

/** Test seam: forget the once-only warnings. */
export function resetControlSecretWarningsForTests(): void {
  warnedMissingKey = false;
  warnedBadKey = false;
  reported.clear();
}
