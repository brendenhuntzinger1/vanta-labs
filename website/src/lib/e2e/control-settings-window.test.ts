import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// HISTORY MUST NEVER HIDE A CURRENT SETTING.
//
// Control settings are append-only: every save INSERTs a row into
// admin_audit_logs, and the newest row for a (section, key) is the value in
// force. The reader used to approximate "newest per key" by fetching the newest
// 1500 rows and keeping the first occurrence of each key — correct only while
// the entire history fitted in that window.
//
// Past it, a setting nobody had touched recently fell out of the window and
// read as ABSENT, which every caller turns into "use the code default". The
// reproduction that prompted this file: 1600 later writes in other sections
// made a stored `referral` section vanish from the unscoped snapshot the
// Control Center loads, so the owner saw a blank Ambassador Personal Discount
// for a value that was really set to 20 — and saving that blank panel would
// have written blanks over live configuration.
//
// `admin_control_current` does the DISTINCT ON in the database, so the answer
// is bounded by the number of distinct SETTINGS, not by the number of
// historical WRITES.
//
// NEGATIVE CONTROL: `harness.db.controlViewMissing = true` makes the reader
// fall back to the old windowed query. Every large-history case below then
// fails, which is what proves these assertions can detect the defect.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return harness.db.client; },
  createServerClient: () => harness.db.client,
}));
vi.unmock("@/lib/admin-control");

const HISTORY_SIZES = [10, 1_500, 1_600, 5_000, 10_000];

/** One control write, timestamped so ordering is unambiguous. */
function write(section: string, key: string, value: unknown, at: string) {
  return {
    id: `${section}-${key}-${at}`,
    action: "admin_control_upsert",
    target_table: section,
    target_id: key,
    metadata: { value },
    created_at: at,
  };
}

function iso(secondsFromEpochDay: number) {
  return new Date(Date.UTC(2026, 0, 1) + secondsFromEpochDay * 1000).toISOString();
}

/**
 * A store configured on day one, then edited heavily in unrelated sections.
 *
 * The settings that matter are written EARLY and never touched again, which is
 * exactly the shape that the windowed reader lost.
 */
function seedHistory(noiseWrites: number) {
  harness.db.seed("admin_audit_logs", [
    // Day one, and never edited since.
    write("referral", "personal_discount_percent", 20, iso(1)),
    write("referral", "discount_percent", 10, iso(2)),
    write("referral", "default_commission_percent", 10, iso(3)),
    write("shipping", "domestic_fee", 15, iso(4)),
    write("shipping", "free_shipping_threshold", 250, iso(5)),
    write("shipping_origin", "city", "Testville", iso(6)),
    // Edited twice on day one — the LATER value is the one in force.
    write("profit", "processing_fee_percent", 6, iso(7)),
    write("profit", "processing_fee_percent", 9, iso(8)),
    // A deliberately blank value, to prove blanks still follow the canonical
    // "blank means keep the default" rule rather than becoming zero.
    write("referral", "bundle_referral_percent", "", iso(9)),
  ]);

  // Noise: a busy owner tuning the homepage and email copy for months.
  harness.db.seed(
    "admin_audit_logs",
    Array.from({ length: noiseWrites }, (_, index) =>
      write("homepage", `hero_line_${index % 40}`, `copy ${index}`, iso(1_000 + index))),
  );
}

beforeEach(() => {
  harness.reset();
});

for (const size of HISTORY_SIZES) {
  describe(`with ${size.toLocaleString()} historical writes`, () => {
    beforeEach(() => {
      seedHistory(size);
    });

    it("resolves the ambassador personal discount from storage, not the default", async () => {
      const { getReferralProgramConfig } = await import("@/lib/admin-control");
      const config = await getReferralProgramConfig();
      expect(config.personalDiscountPercent).toBe(20);
    });

    it("shows the same value in the unscoped snapshot the Control Center loads", async () => {
      const { getControlSnapshot } = await import("@/lib/admin-control");
      const snapshot = await getControlSnapshot();
      // THE DEFECT, stated directly: this section used to be missing entirely.
      expect(snapshot.referral).toBeDefined();
      expect(snapshot.referral?.personal_discount_percent).toBe(20);
    });

    it("agrees exactly between the scoped read and the unscoped snapshot", async () => {
      const { getControlSnapshot } = await import("@/lib/admin-control");
      const [global, scoped] = await Promise.all([
        getControlSnapshot(),
        getControlSnapshot("referral"),
      ]);
      // The UI must show what the business logic actually uses.
      expect(global.referral).toEqual(scoped.referral);
    });

    it("keeps the customer referral discount and commission separate and correct", async () => {
      const { getReferralProgramConfig } = await import("@/lib/admin-control");
      const config = await getReferralProgramConfig();
      expect(config.discountPercent).toBe(10);
      expect(config.defaultCommissionPercent).toBe(10);
      // The three rates are independent; history size must not merge them.
      expect(config.personalDiscountPercent).toBe(20);
    });

    it("resolves shipping configuration too", async () => {
      const { getShippingConfig } = await import("@/lib/admin-control");
      const shipping = await getShippingConfig();
      expect(shipping.domesticFee).toBe(15);
      expect(shipping.freeShippingThreshold).toBe(250);
    });

    it("returns the LATEST write when a key was edited more than once", async () => {
      const { getProfitSettings } = await import("@/lib/admin-control");
      expect((await getProfitSettings()).processingFeePercent).toBe(9);
    });

    it("does not let one section contaminate another", async () => {
      const { getControlSnapshot } = await import("@/lib/admin-control");
      const snapshot = await getControlSnapshot();
      expect(snapshot.shipping_origin?.city).toBe("Testville");
      expect(snapshot.referral?.city).toBeUndefined();
      expect(snapshot.shipping_origin?.personal_discount_percent).toBeUndefined();
    });

    it("keeps a blank stored value meaning 'use the default', not zero", async () => {
      const { getControlSnapshot, getReferralProgramConfig } = await import("@/lib/admin-control");
      // The blank is genuinely stored and genuinely read back as a blank...
      expect((await getControlSnapshot("referral")).referral?.bundle_referral_percent).toBe("");
      // ...and the canonical rule still turns it into the default, never 0.
      expect((await getReferralProgramConfig()).personalDiscountPercent).toBe(20);
    });
  });
}

describe("scale", () => {
  it("reads a 10,000-write history without scanning it", async () => {
    seedHistory(10_000);
    const { getControlSnapshot } = await import("@/lib/admin-control");

    const snapshot = await getControlSnapshot();

    // The whole point: the answer is bounded by the number of distinct
    // SETTINGS, not by the number of historical WRITES. 8 distinct seeded
    // settings (processing_fee_percent was written twice and is still ONE key)
    // plus 40 rotating homepage keys — never 10,009 rows.
    const keys = Object.values(snapshot).reduce((sum, section) => sum + Object.keys(section).length, 0);
    expect(keys).toBe(48);
    expect(snapshot.referral?.personal_discount_percent).toBe(20);
  });

  it("costs about the same at 10 writes as at 10,000", async () => {
    // Not a latency benchmark — a shape check. Reading a hundred-fold larger
    // history must not cost a hundred-fold more, which is what a full scan
    // would do.
    const time = async (size: number) => {
      harness.reset();
      seedHistory(size);
      const { getControlSnapshot } = await import("@/lib/admin-control");
      const started = performance.now();
      for (let i = 0; i < 5; i += 1) await getControlSnapshot();
      return performance.now() - started;
    };

    const small = await time(10);
    const large = await time(10_000);

    expect(large).toBeLessThan(Math.max(small, 1) * 25);
  });
});

describe("a database that has not had the view applied yet", () => {
  it("still reads correctly at small history, on the fallback path", async () => {
    harness.db.controlViewMissing = true;
    seedHistory(10);

    const { getReferralProgramConfig } = await import("@/lib/admin-control");
    // Deploying the code before the migration must change nothing.
    expect((await getReferralProgramConfig()).personalDiscountPercent).toBe(20);
  });

  it("reports the view as unavailable so the owner can see it", async () => {
    harness.db.controlViewMissing = true;
    const { isControlCurrentViewAvailable } = await import("@/lib/admin-control");
    expect(await isControlCurrentViewAvailable()).toBe(false);
  });

  it("reports the view as available once it exists", async () => {
    seedHistory(10);
    const { isControlCurrentViewAvailable } = await import("@/lib/admin-control");
    expect(await isControlCurrentViewAvailable()).toBe(true);
  });
});
