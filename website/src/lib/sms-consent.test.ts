import { beforeEach, describe, expect, it, vi } from "vitest";
import { SMS_CONSENT_TEXT, acceptableSmsPhone } from "@/lib/sms-consent-text";

// ---------------------------------------------------------------------------
// WHAT A TICKED SMS BOX WRITES, AND WHAT IT NEVER WRITES.
//
// sms-consent.ts is the one writer of sms_subscribers. It stores the number,
// the source, the sentence the person ticked and the time; mirrors an account
// holder's decision into customer_preferences; refuses a number nobody could
// be texted at; and tells Omnisend only after the response.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Write = { table: string; op: "upsert" | "update"; values: Record<string, unknown>; options?: unknown };
const db = vi.hoisted(() => ({
  writes: [] as Write[],
  row: null as Record<string, unknown> | null,
  refuse: null as string | null,
}));
const deferred = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.upsert = async (values: Record<string, unknown>, options?: unknown) => {
      db.writes.push({ table, op: "upsert", values, options });
      return { error: db.refuse ? { message: db.refuse } : null };
    };
    chain.update = (values: Record<string, unknown>) => ({
      eq: async () => {
        db.writes.push({ table, op: "update", values });
        return { error: db.refuse ? { message: db.refuse } : null };
      },
    });
    chain.select = () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.row, error: db.refuse ? { message: db.refuse } : null }) }) });
    return chain;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/marketing/omnisend/defer", () => ({
  deferOmnisend: () => { deferred.calls += 1; },
}));

beforeEach(() => {
  db.writes = [];
  db.row = null;
  db.refuse = null;
  deferred.calls = 0;
});

describe("acceptableSmsPhone", () => {
  it.each(["(512) 555-0100", "+1 512 555 0100", "512-555-0100", "5125550100"])("accepts %s as typed", (raw) => {
    expect(acceptableSmsPhone(raw)).toBe(raw);
  });
  it.each(["", "   ", "123456", "1234567890123456", "call me", "555-0100 ext 4"])("refuses %j", (raw) => {
    expect(acceptableSmsPhone(raw)).toBeNull();
  });
});

describe("recordSmsConsent", () => {
  it("writes the address row with the number, the source, the sentence ticked and the time, then tells Omnisend after the response", async () => {
    const { recordSmsConsent } = await import("@/lib/sms-consent");
    expect(await recordSmsConsent({ email: "New@Example.test", phone: "(512) 555-0100", source: "checkout" })).toBe(true);
    expect(db.writes).toHaveLength(1);
    const [row] = db.writes;
    expect(row.table).toBe("sms_subscribers");
    expect(row.options).toEqual({ onConflict: "email" });
    expect(row.values).toMatchObject({ email: "new@example.test", phone: "(512) 555-0100", source: "checkout", opted_out_at: null, consent_text: SMS_CONSENT_TEXT });
    expect(typeof row.values.consented_at).toBe("string");
    expect(deferred.calls).toBe(1);
  });

  it("mirrors an account holder's tick into customer_preferences, so the settings page shows what the checkout collected", async () => {
    const { recordSmsConsent } = await import("@/lib/sms-consent");
    expect(await recordSmsConsent({ email: "new@example.test", phone: "5125550100", source: "signup", userId: "user-1" })).toBe(true);
    const mirror = db.writes.find((write) => write.table === "customer_preferences");
    expect(mirror?.options).toEqual({ onConflict: "user_id" });
    expect(mirror?.values).toMatchObject({ user_id: "user-1", phone: "5125550100", sms_marketing: true, sms_opted_out_at: null });
    expect(typeof mirror?.values.sms_consent_at).toBe("string");
  });

  it("refuses a number nobody could be texted at, writing nothing and telling nobody", async () => {
    const { recordSmsConsent } = await import("@/lib/sms-consent");
    expect(await recordSmsConsent({ email: "new@example.test", phone: "12345", source: "checkout" })).toBe(false);
    expect(await recordSmsConsent({ email: "not an address", phone: "5125550100", source: "checkout" })).toBe(false);
    expect(db.writes).toHaveLength(0);
    expect(deferred.calls).toBe(0);
  });

  it("answers false on a refused consent row and never throws", async () => {
    db.refuse = "relation does not exist";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordSmsConsent } = await import("@/lib/sms-consent");
    expect(await recordSmsConsent({ email: "new@example.test", phone: "5125550100", source: "checkout" })).toBe(false);
    expect(deferred.calls).toBe(0);
  });
});

describe("recordSmsOptOut", () => {
  it("stamps an unstopped row with the instant the person said stop", async () => {
    db.row = { opted_out_at: null };
    const { recordSmsOptOut } = await import("@/lib/sms-consent");
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("applied");
    expect(db.writes[0]).toMatchObject({ table: "sms_subscribers", op: "update", values: { opted_out_at: "2026-09-12T09:00:00.000Z" } });
  });

  it("keeps an existing stamp, and is nothing for an address with no row", async () => {
    const { recordSmsOptOut } = await import("@/lib/sms-consent");
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("nothing");
    db.row = { opted_out_at: "2026-09-01T00:00:00.000Z" };
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("nothing");
    expect(db.writes).toHaveLength(0);
  });

  it("is a failure when the row cannot be read or written, so the reconcile holds its watermark", async () => {
    db.refuse = "permission denied";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordSmsOptOut } = await import("@/lib/sms-consent");
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("failed");
  });
});
