import { describe, expect, it } from "vitest";
import { isInternalAddress, parseInternalAddressList } from "@/lib/email/internal-addresses";

// ---------------------------------------------------------------------------
// THE OWNER'S OWN TESTING IS NOT CUSTOMER BEHAVIOUR.
//
// Measured on 2026-09-10, the owner's two addresses were 11 of 40 abandoned
// carts (25%), 24 of 99 recovery sends (20%) and SIX OF TEN reported
// recoveries (60%). Nothing excluded them, so every rate on the dashboard was
// contaminated — and contaminated in the flattering direction: the owner's
// carts "recovered" at 54.5% against 13.8% for real customers, because the
// owner reliably completes the carts they open while testing.
//
// A store cannot tune a funnel against a number that is three-fifths its own
// staff. This decides which addresses are excluded from reporting — and ONLY
// from reporting: an internal address still receives its mail, so the owner
// can keep testing the real thing.
// ---------------------------------------------------------------------------

const config = {
  siteDomain: "vantalabsresearch.com",
  extra: ["btunchi88@gmail.com"],
};

describe("internal address detection", () => {
  it("excludes an address on the store's own domain", () => {
    expect(isInternalAddress("brendenhuntzinger1@vantalabsresearch.com", config)).toBe(true);
  });

  it("excludes an explicitly listed address on a public domain", () => {
    expect(isInternalAddress("btunchi88@gmail.com", config)).toBe(true);
  });

  it("does not exclude a real customer", () => {
    expect(isInternalAddress("someone@gmail.com", config)).toBe(false);
  });

  it("is case- and whitespace-insensitive, because addresses arrive both ways", () => {
    expect(isInternalAddress("  BTunchi88@Gmail.com ", config)).toBe(true);
    expect(isInternalAddress("STAFF@VantaLabsResearch.com", config)).toBe(true);
  });

  it("excludes the provider's own simulator addresses", () => {
    // These produced the only 'bounce' and 'complaint' in the account and are
    // not people. Counting them as complaints would misreport sender health.
    expect(isInternalAddress("bounced@resend.dev", config)).toBe(true);
    expect(isInternalAddress("complained@resend.dev", config)).toBe(true);
  });

  it("excludes obvious test harness addresses", () => {
    expect(isInternalAddress("qa-anything@example.test", config)).toBe(true);
  });

  it("treats a missing or malformed address as external, never silently dropping a real cart", () => {
    // Over-exclusion is the dangerous direction: it would hide real customers
    // from the funnel. An unparseable address stays in the numbers.
    expect(isInternalAddress("", config)).toBe(false);
    expect(isInternalAddress(null, config)).toBe(false);
    expect(isInternalAddress("not-an-address", config)).toBe(false);
  });

  it("does not match a domain that merely ends with the site domain", () => {
    // notvantalabsresearch.com is a different company.
    expect(isInternalAddress("someone@notvantalabsresearch.com", config)).toBe(false);
  });

  it("matches a subdomain of the store's own domain", () => {
    expect(isInternalAddress("ops@mail.vantalabsresearch.com", config)).toBe(true);
  });
});

describe("parsing the configured list", () => {
  it("reads a comma-separated list, trimming and lowercasing", () => {
    expect(parseInternalAddressList(" A@x.com , b@y.com ")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("tolerates newlines and semicolons, which is how people actually paste lists", () => {
    expect(parseInternalAddressList("a@x.com;b@y.com\nc@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("returns an empty list for empty input rather than a list containing nothing", () => {
    expect(parseInternalAddressList("")).toEqual([]);
    expect(parseInternalAddressList(undefined)).toEqual([]);
  });
});
