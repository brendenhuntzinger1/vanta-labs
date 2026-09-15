import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The per-contact code minter (spec §3.4) is only safe because of the row it
 * writes: bound to ONE address, ONE redemption, private, and traceable to the
 * offer that minted it. `validateCoupon` refuses the code for any other
 * address on the strength of `assigned_email`, and the storefront hides it on
 * the strength of `is_private`. Drop either and a code meant for one inbox
 * becomes a public promotion. These are pinned in source because a database-
 * backed test cannot run here and a wrong column name is a silent failure.
 */
const CODES = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/codes.ts"), "utf8");

function fn(name: string): string {
  const start = CODES.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = CODES.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("codes.ts is server-only", () => {
  it("imports server-only on its first line, so a client bundle cannot pull the service key in", () => {
    expect(CODES.split("\n")[0]).toBe('import "server-only";');
  });
});

describe("the three offers", () => {
  it("are the ones the spec names, each with its own coupon source", () => {
    expect(CODES).toContain('welcome: { percent: 10, ttlHours: 14 * 24, source: "omnisend_welcome", prefix: "VLWELCOME" }');
    expect(CODES).toContain('winback: { percent: 15, ttlHours: 14 * 24, source: "omnisend_winback", prefix: "VLBACK" }');
    expect(CODES).toContain('recovery: { percent: 10, ttlHours: 5 * 24, source: "omnisend_recovery", prefix: "VLCART" }');
  });
});

describe("the mint writes the cart-recovery row shape, bound and private", () => {
  const mint = fn("ensureContactCode");

  it("inserts into coupons with the address, one redemption, private, and the offer's source", () => {
    expect(mint).toMatch(/from\("coupons"\)\.insert\(\{/);
    expect(mint).toContain("assigned_email: address,");
    expect(mint).toContain("max_redemptions: 1,");
    expect(mint).toContain("redemptions_count: 0,");
    expect(mint).toContain("active: true,");
    expect(mint).toContain("is_private: true,");
    expect(mint).toContain("source: offer.source,");
    expect(mint).toContain('discount_type: "percent",');
    expect(mint).toContain("discount_value: offer.percent,");
    expect(mint).toContain("ends_at: endsAt,");
  });

  it("re-offers the live code before minting, so one address never holds two", () => {
    const lookup = mint.indexOf("await findLiveContactCode(kind, address)");
    const insert = mint.indexOf('from("coupons").insert(');
    expect(lookup).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(lookup);
  });

  it("draws the suffix from node:crypto, without the characters people misread", () => {
    expect(CODES).toContain('import { randomBytes } from "node:crypto";');
    expect(CODES).toContain('const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";');
    expect(CODES).not.toMatch(/CODE_ALPHABET = "[^"]*[0O1I][^"]*"/);
    expect(CODES).toContain("return `${prefix}-${suffix}`;");
  });

  it("never throws: both exported functions catch and return null, logging under the module prefix", () => {
    for (const name of ["findLiveContactCode", "ensureContactCode"]) {
      const body = fn(name);
      expect(body).toMatch(/\} catch \(error\) \{\s*console\.error\("\[omnisend\/codes\]/);
      expect(body).toMatch(/catch \(error\) \{\s*console\.error\([^\n]*\);\s*return null;\s*\}/);
    }
  });
});

describe("the live-code lookup only returns a code the checkout will still honour", () => {
  const lookup = fn("findLiveContactCode");

  it("filters by address, source, active and unexpired in the query", () => {
    expect(lookup).toContain('.eq("assigned_email", address)');
    expect(lookup).toContain('.eq("source", offer.source)');
    expect(lookup).toContain('.eq("active", true)');
    expect(lookup).toContain('.gt("ends_at", new Date().toISOString())');
    expect(lookup).toContain('.order("created_at", { ascending: false })');
    expect(lookup).toContain(".limit(1)");
  });

  it("checks redemptions_count < max_redemptions in code, because a spent single-use code is still active in the row", () => {
    expect(lookup).toContain('.select("code, ends_at, redemptions_count, max_redemptions")');
    expect(lookup).toMatch(/Number\(row\.redemptions_count \?\? 0\) < Number\(row\.max_redemptions\)/);
    expect(lookup).toMatch(/return unspent \? \{ code: [^}]+ \} : null;/);
  });
});
