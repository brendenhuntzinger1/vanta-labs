import { describe, expect, it } from "vitest";
import { applySegment, isCampaignSegment, type ConsentedAudience } from "@/lib/email/audience";

// ---------------------------------------------------------------------------
// The rule these tests exist to protect is the one that isn't visible in any
// single line of the implementation: CONSENT IS THE FLOOR. Every segment is a
// filter applied to people who already opted in, never a route to someone who
// didn't. A segment built from order history is the easy way to get that wrong,
// because the orders table contains addresses of people who never consented.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-17T12:00:00.000Z").getTime();

function audience(input: { accounts?: string[]; subscribers?: string[] }): ConsentedAudience {
  const accounts = new Set(input.accounts ?? []);
  const subscribers = new Set(input.subscribers ?? []);
  return { accounts, subscribers, all: new Set([...accounts, ...subscribers]) };
}

describe("consent is the floor", () => {
  it("never returns someone who has not opted in, however well they match", () => {
    // buyer@ has bought recently and repeatedly — and has not consented.
    const result = applySegment({
      segment: "purchasers",
      audience: audience({ subscribers: ["opted-in@example.com"] }),
      lastPaidAt: new Map([
        ["opted-in@example.com", NOW - 5 * DAY],
        ["buyer@example.com", NOW - 5 * DAY],
      ]),
      now: NOW,
    });
    expect(result).toEqual(["opted-in@example.com"]);
    expect(result).not.toContain("buyer@example.com");
  });

  it("holds for the category segment too", () => {
    const result = applySegment({
      segment: "category",
      audience: audience({ subscribers: ["opted-in@example.com"] }),
      lastPaidAt: new Map(),
      categoryBuyers: new Set(["opted-in@example.com", "never-consented@example.com"]),
      now: NOW,
    });
    expect(result).toEqual(["opted-in@example.com"]);
  });
});

describe("dormancy boundaries", () => {
  const base = audience({ subscribers: ["a@example.com", "b@example.com", "c@example.com"] });

  it("includes someone exactly on the boundary and excludes one day inside it", () => {
    // The boundary is the assertion worth having: an off-by-one here is
    // invisible in production and changes who gets mailed.
    const result = applySegment({
      segment: "dormant_30",
      audience: base,
      lastPaidAt: new Map([
        ["a@example.com", NOW - 30 * DAY], // exactly 30 days — dormant
        ["b@example.com", NOW - 29 * DAY], // 29 days — not yet
        ["c@example.com", NOW - 90 * DAY], // long gone
      ]),
      now: NOW,
    });
    expect(result.sort()).toEqual(["a@example.com", "c@example.com"]);
  });

  it("excludes people who never bought — they are the welcome sequence's job", () => {
    const result = applySegment({
      segment: "dormant_60",
      audience: base,
      lastPaidAt: new Map([["a@example.com", NOW - 100 * DAY]]),
      now: NOW,
    });
    expect(result).toEqual(["a@example.com"]);
    expect(result).not.toContain("b@example.com");
  });

  it("60 and 90 day windows nest correctly", () => {
    const lastPaidAt = new Map([
      ["a@example.com", NOW - 45 * DAY],
      ["b@example.com", NOW - 75 * DAY],
      ["c@example.com", NOW - 120 * DAY],
    ]);
    const at = (segment: "dormant_30" | "dormant_60" | "dormant_90") =>
      applySegment({ segment, audience: base, lastPaidAt, now: NOW }).sort();

    expect(at("dormant_30")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(at("dormant_60")).toEqual(["b@example.com", "c@example.com"]);
    expect(at("dormant_90")).toEqual(["c@example.com"]);
  });
});

describe("signed up, never ordered", () => {
  it("means account holders only — not a guest who opted in at checkout", () => {
    // The distinction matters: a guest whose payment failed opted in but never
    // "signed up", and telling them their account is ready would be wrong.
    const result = applySegment({
      segment: "account_no_order",
      audience: audience({ accounts: ["member@example.com"], subscribers: ["guest@example.com"] }),
      lastPaidAt: new Map(),
      now: NOW,
    });
    expect(result).toEqual(["member@example.com"]);
  });

  it("drops an account holder as soon as they buy", () => {
    const result = applySegment({
      segment: "account_no_order",
      audience: audience({ accounts: ["member@example.com"] }),
      lastPaidAt: new Map([["member@example.com", NOW - DAY]]),
      now: NOW,
    });
    expect(result).toEqual([]);
  });
});

describe("all", () => {
  it("is the union of both consent stores, deduped", () => {
    const result = applySegment({
      segment: "all",
      audience: audience({ accounts: ["same@example.com"], subscribers: ["same@example.com", "other@example.com"] }),
      lastPaidAt: new Map(),
      now: NOW,
    });
    expect(result.sort()).toEqual(["other@example.com", "same@example.com"]);
  });
});

describe("isCampaignSegment", () => {
  it("rejects anything not on the list, so a crafted request can't invent a segment", () => {
    expect(isCampaignSegment("all")).toBe(true);
    expect(isCampaignSegment("dormant_30")).toBe(true);
    expect(isCampaignSegment("everyone")).toBe(false);
    expect(isCampaignSegment("")).toBe(false);
    expect(isCampaignSegment(null)).toBe(false);
  });
});
