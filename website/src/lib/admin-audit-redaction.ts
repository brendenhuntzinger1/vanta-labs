/**
 * Keeps credentials out of anything that reads `admin_audit_logs` as an AUDIT
 * LOG.
 *
 * WHY THIS EXISTS RATHER THAN A FIX AT THE WRITE
 *
 * `admin_audit_logs` is doing two jobs at once. It is the audit trail, and it
 * is also the settings store: every save INSERTs an `admin_control_upsert` row
 * and `admin_control_current` is a DISTINCT ON view over exactly those rows
 * (see the CONTROL_VIEW comment in admin-control.ts). So the stored value
 * cannot be redacted at write time — `getControlSnapshot` reads it back to
 * configure email sending and the payment processor, and blanking it would take
 * the store offline.
 *
 * The boundary that CAN be closed is the read. There are two readers:
 *
 *   admin-control.ts  readControlRows   -> CONFIG. Needs the raw value. Untouched.
 *   admin-audit-log.ts getAuditLogRows  -> AUDIT.  Must never see a secret.
 *
 * This module is applied at the second one only.
 *
 * NOT A SUBSTITUTE FOR ROTATION. Redacting the read does not remove the value
 * from the table, from a backup, or from anyone who already read it. Secrets
 * that were written before this landed must be rotated.
 */

export const SECRET_PLACEHOLDER = "••••••••";

/**
 * Substrings that make a settings key or metadata field a credential.
 *
 * Matched against the key with separators and case removed, so `smtp_password`,
 * `smtpPassword` and `SMTP_PASSWORD` all classify the same way. Substring
 * matching rather than an exact list on purpose: the failure mode to avoid is a
 * new credential field nobody remembered to add here, and `resend_api_key`,
 * `sendgrid_api_key` and a future `mailgun_api_key` all carry `apikey`.
 */
const SECRET_KEY_MARKERS = [
  "password",
  "passcode",
  "secret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "authtoken",
  "privatekey",
  "credential",
] as const;

/**
 * Keys that DO contain a marker but are not secret, and must stay readable.
 *
 * These are the "is one configured?" booleans the settings API already returns
 * in place of the values (`secretKeySet`, `webhookSecretSet`, `passwordSet` --
 * see payment-processor-config.ts and email/settings.ts). Redacting a boolean
 * hides real operational history and protects nothing.
 *
 * `publishable_key` is deliberately NOT listed: it matches no marker in the
 * first place, and an exception that never fires reads as protection that is
 * not there. A negative-control mutation caught it sitting here doing nothing.
 */
const NON_SECRET_EXCEPTIONS = ["secretkeyset", "webhooksecretset", "passwordset"] as const;

function canonicalize(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKeyName(key: string) {
  const canonical = canonicalize(key);
  if (!canonical) return false;
  if (NON_SECRET_EXCEPTIONS.some((exception) => canonical === exception)) return false;
  return SECRET_KEY_MARKERS.some((marker) => canonical.includes(marker));
}

/**
 * Is this (section, key) settings entry a credential?
 *
 * The section is accepted for callers that want to reason in settings terms and
 * for future section-specific rules; classification is by key name today,
 * because that is what survives a field being moved between sections.
 */
export function isSensitiveControlEntry(_section: string | null | undefined, key: string | null | undefined) {
  return isSecretKeyName(String(key ?? ""));
}

/** Replace secret-named fields anywhere inside a nested metadata value. */
function redactDeep(value: unknown, depth = 0): unknown {
  // Bounded so a cyclic or pathological row cannot spin here. Settings values
  // are shallow; anything past this is replaced wholesale rather than trusted.
  if (depth > 6) return SECRET_PLACEHOLDER;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKeyName(key) ? SECRET_PLACEHOLDER : redactDeep(nested, depth + 1);
    }
    return out;
  }
  return value;
}

export interface RedactableAuditRow {
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Audit metadata with every credential removed. Returns a new object — the
 * caller's row is never mutated, because the config reader may be looking at
 * the same underlying data.
 *
 * Two rules, both needed:
 *
 *   1. For a settings save, the secret is in `metadata.value` and its NAME is
 *      in `target_id`. `value` itself is not a secret-sounding key, so the
 *      generic rule below cannot see it — the row's target_id is what decides.
 *   2. For any other row, a metadata field whose own name marks it a credential
 *      is redacted. This is what stops a future writer from reopening the hole
 *      under a different action.
 */
export function redactAuditMetadata(row: RedactableAuditRow): Record<string, unknown> | null {
  if (!row.metadata || typeof row.metadata !== "object") {
    return null;
  }

  const redacted = redactDeep(row.metadata) as Record<string, unknown>;

  if ("value" in redacted && isSensitiveControlEntry(row.targetTable, row.targetId)) {
    redacted.value = SECRET_PLACEHOLDER;
  }

  return redacted;
}
