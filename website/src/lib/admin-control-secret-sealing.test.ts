import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE CONTROL STORE SEALS SECRETS ON THE WAY IN AND OPENS THEM ON THE WAY OUT.
//
// upsertControlValue is the single writer and getControlSnapshot the single
// reader for Control Center / Settings values. With the key configured, a
// credential written through the first lands as ciphertext in the audit row
// and comes back in clear from the second; a non-secret key is untouched; a
// legacy clear row still reads. The cart-recovery inputs are also bounded
// here: a typo in that form mints real money.
// ---------------------------------------------------------------------------

const KEY_HEX = "c".repeat(64);
const inserted: Array<Record<string, unknown>> = [];
let rows: Array<{ target_table: string; target_id: string; metadata: Record<string, unknown>; created_at: string }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "order", "limit", "lt", "in"]) b[op] = () => b;
    b.insert = async (payload: Record<string, unknown>) => { inserted.push(payload); return { error: null }; };
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    return b;
  };
  return { supabaseAdmin: { from: () => builder() } };
});

import { isSealedControlValue, resetControlSecretWarningsForTests, sealControlSecret } from "@/lib/control-secret-sealing";
import { getCartRecoveryControlConfig, getControlSnapshot, upsertControlValue } from "@/lib/admin-control";

beforeEach(() => {
  inserted.length = 0;
  rows = [];
  resetControlSecretWarningsForTests();
  process.env.ADMIN_CONTROL_SECRET_KEY = KEY_HEX;
});

describe("secrets through the control store", () => {
  it("seals a credential on write and never stores it in clear", async () => {
    await upsertControlValue({ section: "email", key: "smtp_password", value: "hunter2-smtp" });
    const meta = inserted[0].metadata as Record<string, unknown>;
    expect(isSealedControlValue(meta.value)).toBe(true);
    expect(JSON.stringify(inserted[0])).not.toContain("hunter2-smtp");
  });

  it("leaves a non-secret setting exactly as typed", async () => {
    await upsertControlValue({ section: "shipping", key: "flat_rate", value: "15" });
    expect((inserted[0].metadata as Record<string, unknown>).value).toBe("15");
  });

  it("opens a sealed row on read, and passes a legacy clear row through", async () => {
    rows = [
      { target_table: "email", target_id: "smtp_password", metadata: { value: sealControlSecret("opened-fine") }, created_at: "2026-09-05T00:00:00Z" },
      { target_table: "email", target_id: "resend_api_key", metadata: { value: "re_legacy_clear" }, created_at: "2026-09-04T00:00:00Z" },
      { target_table: "email", target_id: "provider", metadata: { value: "smtp" }, created_at: "2026-09-04T00:00:00Z" },
    ];
    const snapshot = await getControlSnapshot("email");
    expect(snapshot.email.smtp_password).toBe("opened-fine");
    expect(snapshot.email.resend_api_key).toBe("re_legacy_clear");
    expect(snapshot.email.provider).toBe("smtp");
  });

  it("without the key, writes and reads exactly as before", async () => {
    delete process.env.ADMIN_CONTROL_SECRET_KEY;
    await upsertControlValue({ section: "payment_processor", key: "secret_key", value: "sk_clear" });
    expect((inserted[0].metadata as Record<string, unknown>).value).toBe("sk_clear");
  });
});

describe("cart-recovery inputs are bounded", () => {
  it("clamps the discount to 0–100 and the expiry to at least one hour", async () => {
    rows = [
      { target_table: "cart_recovery", target_id: "discount_percent", metadata: { value: "150" }, created_at: "2026-09-05T00:00:00Z" },
      { target_table: "cart_recovery", target_id: "coupon_expiration_hours", metadata: { value: "0" }, created_at: "2026-09-05T00:00:00Z" },
    ];
    const config = await getCartRecoveryControlConfig();
    expect(config.discountPercent).toBe(100);
    expect(config.couponExpirationHours).toBe(1);
  });

  it("falls back to the defaults for unparseable values instead of NaN", async () => {
    rows = [
      { target_table: "cart_recovery", target_id: "discount_percent", metadata: { value: "ten" }, created_at: "2026-09-05T00:00:00Z" },
      { target_table: "cart_recovery", target_id: "coupon_expiration_hours", metadata: { value: "soon" }, created_at: "2026-09-05T00:00:00Z" },
    ];
    const config = await getCartRecoveryControlConfig();
    expect(Number.isFinite(config.discountPercent)).toBe(true);
    expect(Number.isFinite(config.couponExpirationHours)).toBe(true);
    expect(config.discountPercent).toBeGreaterThanOrEqual(0);
    expect(config.couponExpirationHours).toBeGreaterThanOrEqual(1);
  });
});
