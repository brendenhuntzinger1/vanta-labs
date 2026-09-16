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
    expect(mint).toContain("discount_value: percent,");
    expect(mint).toContain("ends_at: endsAt,");
  });

  // THE BAND'S PERCENTAGE, NOT THE DEFAULT. The cart-offer sweep plans the
  // 72-hour incentive from the cart's value band (cart-recovery-offers.ts),
  // and a $150 cart whose band says 10% must not be minted the welcome
  // default. The default stays what it was for every existing caller, and
  // the row records the percentage actually minted so the contact property
  // can never describe a code the till prices differently.
  it("mints at the caller's percentage when one is given, and at the offer's default otherwise", () => {
    expect(CODES).toContain("export async function ensureContactCode(kind: ContactCodeKind, email: string, options: { percent?: number } = {})");
    expect(mint).toContain("const percent = boundedPercent(options.percent, offer.percent);");
    expect(CODES).toMatch(/function boundedPercent\(value: unknown, fallback: number\): number \{/);
    // Whole percentages inside 1..100; anything else is the default, not a free order.
    expect(CODES).toContain("if (!Number.isFinite(parsed)) return fallback;");
    expect(CODES).toContain("return Math.min(100, Math.max(1, Math.round(parsed)));");
    expect(mint).toContain("return { code, endsAt, percent };");
  });

  it("reads the percentage back off the live row, never from memory", () => {
    const lookup = fn("findLiveContactCode");
    expect(lookup).toContain('.select("code, ends_at, redemptions_count, max_redemptions, discount_value, discount_type")');
    expect(lookup).toContain("percent: percentOf(row)");
    expect(CODES).toMatch(/function percentOf\(row: LiveCodeRow\): number \{/);
    expect(CODES).toContain('String(row.discount_type ?? "percent") === "percent"');
  });

  it("offers one lookup for every kind at once, so the hooks read what is real rather than minting", () => {
    expect(CODES).toContain("export async function findLiveContactCodes(email: string): Promise<Partial<Record<ContactCodeKind, ContactCode>>>");
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

// THE WELCOME CODE IS FOR A FIRST ORDER, AND A FIRST ORDER ENDS IT. The code
// is minted when an address subscribes with no paid order, and nothing
// enforced "first order" after that: a contact who paid without it kept a
// live code Omnisend would go on showing. order-hooks.ts retires it on the
// paid hook. Retiring is `active = false` on the live rows — never a delete
// (the row is the audit trail of what was offered), never a redeemed row
// (that one is spent, and its count is the record of the order it priced).
describe("retireContactCode deactivates the live codes of one kind for one address", () => {
  const retire = fn("retireContactCode");

  it("is exported with the kind and the address, and never throws", () => {
    expect(CODES).toContain("export async function retireContactCode(kind: ContactCodeKind, email: string): Promise<number>");
    expect(retire).toMatch(/\} catch \(error\) \{\s*console\.error\("\[omnisend\/codes\]/);
    expect(retire).toMatch(/catch \(error\) \{\s*console\.error\([^\n]*\);\s*return 0;\s*\}/);
  });

  it("updates active to false on the address's live rows of that source, and only unredeemed ones", () => {
    expect(retire).toMatch(/from\("coupons"\)\s*\.update\(\{ active: false \}\)/);
    expect(retire).toContain('.eq("assigned_email", address)');
    expect(retire).toContain('.eq("source", offer.source)');
    expect(retire).toContain('.eq("active", true)');
    expect(retire).toContain('.eq("redemptions_count", 0)');
    expect(retire).not.toContain(".delete(");
    expect(retire).not.toContain(".insert(");
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
    expect(lookup).toContain('.select("code, ends_at, redemptions_count, max_redemptions, discount_value, discount_type")');
    expect(lookup).toMatch(/Number\(row\.redemptions_count \?\? 0\) < Number\(row\.max_redemptions\)/);
    expect(lookup).toMatch(/return unspent \? \{ code: [^}]+ \} : null;/);
  });
});
