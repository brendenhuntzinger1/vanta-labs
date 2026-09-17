import { beforeEach, describe, expect, it, vi } from "vitest";
import { SMS_DISCLOSURE_VERSION, acceptableSmsPhone } from "@/lib/sms-consent-text";

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
  /** What a single-row read (by phone) finds. */
  row: null as Record<string, unknown> | null,
  /** What a list read (every row for an address) finds. */
  rows: [] as Record<string, unknown>[],
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
    const writeResult = async () => {
      db.writes.push({ table, op: "update", values: pendingUpdate });
      return { error: db.refuse ? { message: db.refuse } : null };
    };
    let pendingUpdate: Record<string, unknown> = {};
    chain.update = (values: Record<string, unknown>) => {
      pendingUpdate = values;
      return { eq: writeResult, in: writeResult };
    };
    chain.insert = async (values: Record<string, unknown>) => {
      db.writes.push({ table, op: "upsert", values });
      return { error: db.refuse ? { message: db.refuse } : null };
    };
    // A list read resolves through `then`; a single-row read asks for
    // maybeSingle. The real client offers both off the same builder.
    const listResult = () => ({ data: db.rows, error: db.refuse ? { message: db.refuse } : null });
    const eqChain: Record<string, unknown> = {
      maybeSingle: async () => ({ data: db.row, error: db.refuse ? { message: db.refuse } : null }),
      order: () => ({ limit: async () => listResult() }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(listResult()).then(resolve),
    };
    chain.select = () => ({ eq: () => eqChain });
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
  db.rows = [];
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
    expect(row.options).toEqual({ onConflict: "phone_e164" });
    // The columns production's table actually has: the number normalised to
    // E.164 as the key, marketing consent as its own flag, the screen that
    // collected it, and WHICH VERSION of the sentence was on screen.
    expect(row.values).toMatchObject({
      phone_e164: "+15125550100",
      email: "new@example.test",
      marketing_consent: true,
      consent_source: "checkout",
      disclosure_version: SMS_DISCLOSURE_VERSION,
      opted_out_at: null,
    });
    expect(typeof row.values.marketing_consent_at).toBe("string");
    expect(deferred.calls).toBe(1);
  });

  it("mirrors an account holder's tick into customer_preferences, so the settings page shows what the checkout collected", async () => {
    const { recordSmsConsent } = await import("@/lib/sms-consent");
    expect(await recordSmsConsent({ email: "new@example.test", phone: "5125550100", source: "signup", userId: "user-1" })).toBe(true);
    const mirror = db.writes.find((write) => write.table === "customer_preferences");
    expect(mirror?.options).toEqual({ onConflict: "user_id" });
    expect(mirror?.values).toMatchObject({ user_id: "user-1", phone: "+15125550100", sms_marketing: true, sms_opted_out_at: null });
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
    // A stop reaches EVERY live number the address consented from, because a
    // person who says stop means the person and not the handset.
    db.rows = [{ phone_e164: "+15125550100", opted_out_at: null }, { phone_e164: "+15125550111", opted_out_at: null }];
    const { recordSmsOptOut } = await import("@/lib/sms-consent");
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("applied");
    expect(db.writes[0]).toMatchObject({
      table: "sms_subscribers",
      op: "update",
      values: { opted_out_at: "2026-09-12T09:00:00.000Z", marketing_consent: false, status: "opted_out", opt_out_keyword: "STOP" },
    });
  });

  it("keeps an existing stamp, and is nothing for an address with no row", async () => {
    const { recordSmsOptOut } = await import("@/lib/sms-consent");
    expect(await recordSmsOptOut("new@example.test", "2026-09-12T09:00:00.000Z")).toBe("nothing");
    db.rows = [{ phone_e164: "+15125550100", opted_out_at: "2026-09-01T00:00:00.000Z" }];
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
