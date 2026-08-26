import { describe, expect, it } from "vitest";
import { isSensitiveControlEntry, redactAuditMetadata, SECRET_PLACEHOLDER } from "@/lib/admin-audit-redaction";

// ---------------------------------------------------------------------------
// I-01. `admin_audit_logs` is BOTH the audit trail and the settings store —
// `admin_control_current` is a view over its `admin_control_upsert` rows — so
// the stored value cannot simply be dropped at write time without breaking
// email sending and payment configuration.
//
// The boundary that CAN be closed is the read: anything reading the table AS AN
// AUDIT LOG must never receive a secret, while the config reader
// (`getControlSnapshot` -> `readControlRows`) keeps the raw value.
//
// Production, 2026-08-26, verified read-only by counting rows and value LENGTHS
// only (never the values):
//   email/resend_api_key         2 rows, non-empty, max len 36
//   email/smtp_password          1 row,  non-empty, max len 19
//   fulfillment/webhook_secret   1 row,  non-empty, max len 64
// These are live secrets, and /admin/audit-log?includeConfigSaves=1 prints
// `metadata.value` verbatim.
// ---------------------------------------------------------------------------

const controlRow = (section: string, key: string, value: unknown) => ({
  action: "admin_control_upsert",
  targetTable: section,
  targetId: key,
  metadata: { value, actorUsername: "owner", ipAddress: "203.0.113.7", userAgent: "curl" },
});

describe("I-01 — secrets must not survive the audit-log read boundary", () => {
  it.each([
    ["email", "smtp_password"],
    ["email", "resend_api_key"],
    ["email", "sendgrid_api_key"],
    ["payment_processor", "secret_key"],
    ["payment_processor", "webhook_secret"],
    // A legacy 3PL credential set is present in production even though the
    // settings route no longer writes fulfillment credentials at all. Found by
    // listing the section rather than by querying key names I had guessed --
    // my first enumeration filtered on a name list and missed api_key.
    ["fulfillment", "webhook_secret"],
    ["fulfillment", "api_key"],
  ])("redacts %s/%s", (section, key) => {
    const redacted = redactAuditMetadata(controlRow(section, key, "sk_live_THE_ACTUAL_SECRET"));
    expect(redacted?.value).toBe(SECRET_PLACEHOLDER);
    expect(JSON.stringify(redacted)).not.toContain("sk_live_THE_ACTUAL_SECRET");
  });

  it("keeps non-secret settings readable — an audit log that hides everything is useless", () => {
    expect(redactAuditMetadata(controlRow("payment_processor", "provider", "veyra"))?.value).toBe("veyra");
    expect(redactAuditMetadata(controlRow("payment_processor", "publishable_key", "pk_live_abc"))?.value).toBe("pk_live_abc");
    expect(redactAuditMetadata(controlRow("payment_processor", "enabled", true))?.value).toBe(true);
    expect(redactAuditMetadata(controlRow("business", "support_email", "help@vanta.test"))?.value).toBe("help@vanta.test");
    expect(redactAuditMetadata(controlRow("welcome_offer", "code", "WELCOME10"))?.value).toBe("WELCOME10");
  });

  it("preserves the surrounding audit fields — who and from where must still be recorded", () => {
    const redacted = redactAuditMetadata(controlRow("email", "smtp_password", "hunter2"));
    expect(redacted?.actorUsername).toBe("owner");
    expect(redacted?.ipAddress).toBe("203.0.113.7");
  });

  it("redacts a secret-shaped key in ANY audit row, not just control saves", () => {
    // A future writer that stashes a credential under a different action must
    // not reopen this. Keyed on the metadata key name, not on the action.
    const redacted = redactAuditMetadata({
      action: "processor_reconnect",
      targetTable: "payment_processor",
      targetId: "acct_1",
      metadata: { apiKey: "sk_live_LEAK", webhookSecret: "whsec_LEAK", note: "reconnected" },
    });
    expect(redacted?.apiKey).toBe(SECRET_PLACEHOLDER);
    expect(redacted?.webhookSecret).toBe(SECRET_PLACEHOLDER);
    expect(redacted?.note).toBe("reconnected");
  });

  it("redacts a secret nested inside an object value", () => {
    const redacted = redactAuditMetadata({
      action: "admin_control_upsert",
      targetTable: "email",
      targetId: "provider_config",
      metadata: { value: { host: "smtp.test", smtp_password: "hunter2" } },
    });
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).toContain("smtp.test");
  });

  it("survives null and non-object metadata without throwing", () => {
    expect(redactAuditMetadata({ action: "x", targetTable: null, targetId: null, metadata: null })).toBeNull();
  });

  it("does not mutate the row it was given", () => {
    const row = controlRow("email", "resend_api_key", "re_LIVE_KEY");
    redactAuditMetadata(row);
    expect(row.metadata.value).toBe("re_LIVE_KEY");
  });

  it("keeps the settings API's is-it-configured booleans readable", () => {
    // These carry a marker substring but hold no secret -- they are exactly
    // what the settings API returns INSTEAD of the value. Redacting them would
    // hide whether a processor was ever configured.
    const redacted = redactAuditMetadata({
      action: "settings_snapshot",
      targetTable: "payment_processor",
      targetId: "state",
      metadata: { secretKeySet: true, webhookSecretSet: false, passwordSet: true, secret_key: "sk_live_LEAK" },
    });
    expect(redacted?.secretKeySet).toBe(true);
    expect(redacted?.webhookSecretSet).toBe(false);
    expect(redacted?.passwordSet).toBe(true);
    // ...while the real credential beside them is still removed.
    expect(redacted?.secret_key).toBe(SECRET_PLACEHOLDER);
  });

  it("classifies by key name, case- and separator-insensitively", () => {
    expect(isSensitiveControlEntry("email", "smtp_password")).toBe(true);
    expect(isSensitiveControlEntry("email", "SMTP_PASSWORD")).toBe(true);
    expect(isSensitiveControlEntry("anything", "resendApiKey")).toBe(true);
    expect(isSensitiveControlEntry("payment_processor", "publishable_key")).toBe(false);
    expect(isSensitiveControlEntry("homepage", "heroHeadline")).toBe(false);
  });
});
