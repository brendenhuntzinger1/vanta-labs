import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-01 REPRODUCTION, at the boundary that actually leaks.
//
// `admin_audit_logs` is BOTH the audit trail and the settings store
// (`admin_control_current` is a view over its `admin_control_upsert` rows), so
// the value cannot be dropped at write time — email sending and payment
// configuration read it back. The boundary that CAN be closed is the read:
// `getAuditLogRows` is the AUDIT reader, and the audit-log page prints every
// metadata key it returns except performedAt/ipAddress/userAgent/performedBy.
//
// Verified against production 2026-08-26, read-only, by counting rows and
// value LENGTHS only — never the values themselves:
//
//   email/resend_api_key         2 rows, non-empty, max len 36
//   email/smtp_password          1 row,  non-empty, max len 19
//   fulfillment/webhook_secret   1 row,  non-empty, max len 64
//
// Those rows are reachable at /admin/audit-log?includeConfigSaves=1 today.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state: { rows: Array<Record<string, unknown>> } = { rows: [] };

vi.mock("@/lib/supabase-server", () => {
  const from = () => {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      neq() { return b; },
      ilike() { return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      range: async () => ({ data: state.rows, error: null, count: state.rows.length }),
      then(resolve: (v: { data: unknown; error: unknown; count: number }) => unknown) {
        return Promise.resolve({ data: state.rows, error: null, count: state.rows.length }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

function controlRow(section: string, key: string, value: unknown) {
  return {
    id: `${section}-${key}`,
    action: "admin_control_upsert",
    target_table: section,
    target_id: key,
    metadata: { value, actorUsername: "owner", ipAddress: "203.0.113.7", userAgent: "curl/8" },
    created_at: "2026-07-21T05:48:35.716Z",
  };
}

async function getAuditLogRows() {
  return (await import("@/lib/admin-audit-log")).getAuditLogRows;
}

/** Exactly what src/app/admin/audit-log/page.tsx renders in the Details cell. */
const HIDDEN = new Set(["performedAt", "ipAddress", "userAgent", "performedBy"]);
function renderDetailsCell(metadata: Record<string, unknown> | null) {
  if (!metadata) return "";
  return Object.entries(metadata)
    .filter(([k, v]) => !HIDDEN.has(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" • ");
}

beforeEach(() => {
  state.rows = [];
});

describe("I-01 — the audit-log reader must not hand out provider secrets", () => {
  it.each([
    ["email", "smtp_password", "hunter2-smtp-pass"],
    ["email", "resend_api_key", "re_LIVE_0123456789abcdef0123456789ab"],
    ["email", "sendgrid_api_key", "SG.LIVE_KEY_MATERIAL"],
    ["payment_processor", "secret_key", "sk_live_PROCESSOR_SECRET"],
    ["payment_processor", "webhook_secret", "whsec_LIVE_SIGNING_SECRET"],
    // Present in production despite the settings route no longer writing it.
    ["fulfillment", "webhook_secret", "a".repeat(64)],
  ])("does not return %s/%s in metadata.value", async (section, key, secret) => {
    state.rows = [controlRow(section, key, secret)];
    const result = await (await getAuditLogRows())({ includeConfigSaves: true });

    expect(JSON.stringify(result.rows)).not.toContain(secret);
  });

  it("does not let the audit-log page render a secret in its Details column", async () => {
    const secret = "re_LIVE_0123456789abcdef0123456789ab";
    state.rows = [controlRow("email", "resend_api_key", secret)];
    const result = await (await getAuditLogRows())({ includeConfigSaves: true });

    expect(renderDetailsCell(result.rows[0]?.metadata ?? null)).not.toContain(secret);
  });

  it("still returns non-secret settings — an audit log that hides everything is useless", async () => {
    state.rows = [
      controlRow("payment_processor", "provider", "veyra"),
      controlRow("payment_processor", "publishable_key", "pk_live_public_by_design"),
      controlRow("welcome_offer", "code", "WELCOME10"),
    ];
    const result = await (await getAuditLogRows())({ includeConfigSaves: true });
    const values = result.rows.map((row) => row.metadata?.value);

    expect(values).toContain("veyra");
    expect(values).toContain("pk_live_public_by_design");
    expect(values).toContain("WELCOME10");
  });

  it("still records WHO made the change and from where", async () => {
    state.rows = [controlRow("email", "smtp_password", "hunter2-smtp-pass")];
    const result = await (await getAuditLogRows())({ includeConfigSaves: true });

    expect(result.rows[0]?.metadata?.actorUsername).toBe("owner");
    expect(result.rows[0]?.metadata?.ipAddress).toBe("203.0.113.7");
  });
});
