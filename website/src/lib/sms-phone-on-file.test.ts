import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// HOLDING A NUMBER IS NOT PERMISSION TO TEXT IT.
//
// The wheel collects a phone from everybody. The SMS consent box beside it is
// separate, optional and unticked. So the store has to be able to keep a number
// while recording, plainly and everywhere, that nobody may market to it — and
// it has to be able to flip that same number to subscribed later, from an
// explicit tick, without the number being collected again.
//
// These pin the four facts that make that safe:
//
//   * a stored number is not a subscriber, to every reader that asks;
//   * storing a number never downgrades somebody who HAS consented;
//   * storing a number never resurrects somebody who said STOP;
//   * approval day promotes nobody — only a tick does.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Write = { table: string; values: Record<string, unknown>; options?: unknown };
const db = vi.hoisted(() => ({
  writes: [] as Write[],
  row: null as Record<string, unknown> | null,
  rows: [] as Record<string, unknown>[],
  refuse: null as string | null,
}));
const deferred = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.upsert = async (values: Record<string, unknown>, options?: unknown) => {
      db.writes.push({ table, values, options });
      return { error: db.refuse ? { message: db.refuse } : null };
    };
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

const { recordPhoneOnFile, readSmsStanding } = await import("@/lib/sms-consent");

const ledgerWrite = () => db.writes.find((w) => w.table === "sms_subscribers");
const profileWrite = () => db.writes.find((w) => w.table === "customer_preferences");

beforeEach(() => {
  db.writes = [];
  db.row = null;
  db.rows = [];
  db.refuse = null;
  deferred.calls = 0;
});

describe("what storing a number writes", () => {
  it("keeps the number and says plainly that it may not be marketed to", async () => {
    const ok = await recordPhoneOnFile({
      email: "Shopper@Example.test",
      phone: "(512) 555-0100",
      source: "storefront",
      userId: "user-1",
    });
    expect(ok).toBe(true);

    const ledger = ledgerWrite();
    expect(ledger?.values.phone_e164).toBe("+15125550100");
    expect(ledger?.values.email).toBe("shopper@example.test");
    expect(ledger?.values.marketing_consent, "a stored number must not read as consent").toBe(false);
    expect(ledger?.values.consent_source).toBe("storefront");
  });

  it("writes no consent timestamp and no disclosure version", async () => {
    // Both describe a consent. There is none, and inventing either would put a
    // record in front of a carrier that says somebody agreed to something.
    await recordPhoneOnFile({ email: "s@example.test", phone: "5125550100", source: "storefront" });
    const ledger = ledgerWrite();
    expect(ledger?.values).not.toHaveProperty("marketing_consent_at");
    expect(ledger?.values).not.toHaveProperty("disclosure_version");
  });

  it("puts the number on the profile without touching the marketing flag", async () => {
    await recordPhoneOnFile({ email: "s@example.test", phone: "5125550100", source: "storefront", userId: "user-1" });
    const profile = profileWrite();
    expect(profile?.values.phone).toBe("+15125550100");
    expect(profile?.values, "the wheel must not tick the account's SMS box").not.toHaveProperty("sms_marketing");
    expect(profile?.values).not.toHaveProperty("sms_consent_at");
  });

  it("refuses a number nobody could be texted at", async () => {
    expect(await recordPhoneOnFile({ email: "s@example.test", phone: "1234567890", source: "storefront" })).toBe(false);
    expect(db.writes).toHaveLength(0);
  });
});

describe("what it must never overwrite", () => {
  it("leaves an existing row alone rather than upserting over it", async () => {
    // THE BUG THIS AVOIDS: an upsert carrying `marketing_consent: false` would
    // unsubscribe a live subscriber the moment they typed their own number
    // into the wheel, and would wipe the opt-out of somebody who had said
    // STOP. A row that already exists knows more about the number than this
    // call does.
    await recordPhoneOnFile({ email: "s@example.test", phone: "5125550100", source: "storefront" });
    expect(ledgerWrite()?.options).toEqual({ onConflict: "phone_e164", ignoreDuplicates: true });
  });
});

describe("what every reader makes of a stored number", () => {
  it("reads it as not subscribed", async () => {
    db.rows = [{ marketing_consent: false, opted_out_at: null }];
    expect(await readSmsStanding("shopper@example.test")).toBe("none");
  });

  it("still reads a real consent as subscribed", async () => {
    db.rows = [{ marketing_consent: true, opted_out_at: null }];
    expect(await readSmsStanding("shopper@example.test")).toBe("subscribed");
  });

  it("still reads a stop as a stop", async () => {
    db.rows = [{ marketing_consent: false, opted_out_at: "2026-09-01T00:00:00.000Z" }];
    expect(await readSmsStanding("shopper@example.test")).toBe("opted_out");
  });
});

describe("the day Omnisend SMS is approved", () => {
  it("promotes nobody on its own", async () => {
    // Approval changes what the store may SEND, not what anyone agreed to. So
    // the writer that merely keeps a number may never set consent, whatever
    // else changes around it.
    const source = (await import("node:fs")).readFileSync(
      new URL("./sms-consent.ts", import.meta.url), "utf8",
    );
    const storeOnly = source.slice(source.indexOf("export async function recordPhoneOnFile"));
    expect(storeOnly.slice(0, storeOnly.indexOf("\n}\n"))).not.toContain("marketing_consent: true");
  });

  it("is written by exactly the two paths a person can tick", async () => {
    // recordSmsConsent is this store's own box. mirrorSmsConsent is the tick
    // somebody gave Omnisend's pop-up, copied across once. Both are a person
    // agreeing; a third writer would be the store deciding for them.
    const source = (await import("node:fs")).readFileSync(
      new URL("./sms-consent.ts", import.meta.url), "utf8",
    );
    const writers = ["export async function recordSmsConsent", "export async function mirrorSmsConsent"]
      .map((name) => source.indexOf(name));
    expect(writers.every((at) => at > -1)).toBe(true);
    expect((source.match(/marketing_consent: true/g) ?? []).length).toBe(writers.length);
  });
});

describe("a number the store merely holds does not block a real consent", () => {
  it("promotes a held row when Omnisend reports the person ticked its pop-up", async () => {
    // THE GAP THIS CLOSES. mirrorSmsConsent used to refuse on ANY existing
    // row, which was every row there could be until numbers started being
    // kept with no permission attached. A wheel entrant who later ticked
    // Omnisend's own pop-up would have met their own held row and stayed
    // unsubscribed for ever: the store holding the number, Omnisend holding
    // the consent, and nothing joining the two.
    const { mirrorSmsConsent } = await import("@/lib/sms-consent");
    db.row = { phone_e164: "+15125550100", marketing_consent: false, opted_out_at: null };
    const outcome = await mirrorSmsConsent({
      email: "s@example.test", phone: "5125550100", source: "omnisend-form", at: "2026-09-18T10:00:00.000Z",
    });
    expect(outcome).toBe("applied");
    expect(ledgerWrite()?.values.marketing_consent).toBe(true);
    expect(ledgerWrite()?.values.marketing_consent_at).toBe("2026-09-18T10:00:00.000Z");
  });

  it("still refuses to re-stamp a consent that already exists", async () => {
    // The reason the guard was there: re-stamping marketing_consent_at every
    // half-hourly tick rewrites the date the person agreed, which is the one
    // field a carrier dispute turns on.
    const { mirrorSmsConsent } = await import("@/lib/sms-consent");
    db.row = { phone_e164: "+15125550100", marketing_consent: true, marketing_consent_at: "2026-01-01T00:00:00.000Z" };
    expect(await mirrorSmsConsent({
      email: "s@example.test", phone: "5125550100", source: "omnisend-form", at: "2026-09-18T10:00:00.000Z",
    })).toBe("nothing");
    expect(db.writes).toHaveLength(0);
  });

  it("still refuses to resurrect somebody who said stop", async () => {
    const { mirrorSmsConsent } = await import("@/lib/sms-consent");
    db.row = { phone_e164: "+15125550100", marketing_consent: false, opted_out_at: "2026-05-01T00:00:00.000Z" };
    expect(await mirrorSmsConsent({
      email: "s@example.test", phone: "5125550100", source: "omnisend-form", at: "2026-09-18T10:00:00.000Z",
    })).toBe("nothing");
    expect(db.writes).toHaveLength(0);
  });
});
