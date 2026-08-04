import { describe, expect, it } from "vitest";

// The membership cards showed the same facts three times: as headline boxes, in
// the "What you get" table, and again as admin-authored bullets. This mirrors
// the card's dedupe rule so the behaviour is pinned — conservative by design,
// because hiding a real perk is worse than showing one twice.
function restatesStructuredPerk(
  benefit: string,
  tier: {
    memberDiscountPercent: number;
    monthlyStoreCreditCents: number;
    freeShipping: boolean;
    priorityShipping: boolean;
    earlyAccess: boolean;
    referralBonusPoints: number;
  },
): boolean {
  const text = benefit.toLowerCase();
  const has = (...words: string[]) => words.every((w) => text.includes(w));
  if (tier.memberDiscountPercent > 0 && (has("member", "discount") || has("member", "pricing") || has(`${tier.memberDiscountPercent}%`))) return true;
  if (tier.monthlyStoreCreditCents > 0 && has("store credit")) return true;
  if (tier.freeShipping && has("free", "shipping")) return true;
  if (tier.priorityShipping && (has("priority", "processing") || has("priority", "order"))) return true;
  if (tier.earlyAccess && has("early access")) return true;
  if (tier.referralBonusPoints > 0 && has("referral")) return true;
  if (has("points", "per $1") || has("point", "multiplier")) return true;
  return false;
}

const ESSENTIAL = {
  memberDiscountPercent: 5, monthlyStoreCreditCents: 500, freeShipping: false,
  priorityShipping: false, earlyAccess: true, referralBonusPoints: 100,
};
const PRO = {
  memberDiscountPercent: 8, monthlyStoreCreditCents: 1500, freeShipping: true,
  priorityShipping: true, earlyAccess: true, referralBonusPoints: 150,
};

describe("drops bullets that restate the card's own numbers", () => {
  it("drops the member discount, shown as a headline box", () => {
    expect(restatesStructuredPerk("5% member discount on all products", ESSENTIAL)).toBe(true);
    expect(restatesStructuredPerk("8% member discount", PRO)).toBe(true);
  });

  it("drops store credit, shown as a headline box", () => {
    expect(restatesStructuredPerk("$5 monthly store credit", ESSENTIAL)).toBe(true);
    expect(restatesStructuredPerk("$15 monthly store credit", PRO)).toBe(true);
  });

  it("drops shipping, processing, early access and referral when structurally shown", () => {
    expect(restatesStructuredPerk("Free 2-day shipping", PRO)).toBe(true);
    expect(restatesStructuredPerk("Priority order processing", PRO)).toBe(true);
    expect(restatesStructuredPerk("Early access to limited drops", PRO)).toBe(true);
    expect(restatesStructuredPerk("Referral bonus points", PRO)).toBe(true);
  });

  it("drops points restatements", () => {
    expect(restatesStructuredPerk("Earn 3 points per $1 spent", PRO)).toBe(true);
  });
});

describe("keeps everything genuinely unique", () => {
  it("keeps perks the card cannot express structurally", () => {
    for (const perk of [
      "Members-only promotions",
      "Birthday reward",
      "Priority email support",
      "Members-only products",
      "Free research supply kit every 3 months",
      "Private VIP community access",
      "Beta product access",
      "Exclusive limited releases",
      "Concierge priority support",
    ]) {
      expect(restatesStructuredPerk(perk, PRO)).toBe(false);
    }
  });

  it("keeps a shipping bullet when the tier has NO free shipping", () => {
    // Essential's "free standard shipping on $200+" is a real, different claim.
    expect(restatesStructuredPerk("Free standard shipping on $200+ orders", ESSENTIAL)).toBe(false);
  });

  it("keeps a priority bullet when the tier has no priority processing", () => {
    expect(restatesStructuredPerk("Priority order processing", ESSENTIAL)).toBe(false);
  });

  it("an unrecognised bullet is always kept", () => {
    expect(restatesStructuredPerk("Something the admin invented last week", PRO)).toBe(false);
    expect(restatesStructuredPerk("", PRO)).toBe(false);
  });
});
