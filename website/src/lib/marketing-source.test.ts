import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mayReplaceMarketingSource, resolveMarketingSource } from "@/lib/marketing-source";

// ---------------------------------------------------------------------------
// THE ONE RULE THAT DECIDES WHICH CHANNEL AN ORDER BELONGS TO.
//
// Every admin surface that shows revenue by channel reads the primary source
// this rule writes, so the precedence pinned here is what stops one order
// being two channels' revenue at once.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000;

describe("resolveMarketingSource precedence", () => {
  it("a redeemed gift token beats everything, and credits the automation that minted it", () => {
    expect(resolveMarketingSource({
      redeemedOffer: { automationKey: "winback_30", offerKey: "winback_60_bac_water_10" },
      automationClick: { key: "welcome_no_purchase", clickedAtMs: T },
      campaignClick: { campaignId: "camp-1", clickedAtMs: T + 5000 },
      recoveryCoupon: { code: "SAVE-ABC" },
      ambassadorId: "amb-1",
      adTouch: { source: "tiktok", campaign: "spring", clickId: "ttclid" },
    })).toEqual({ kind: "automation", ref: "winback_30", basis: "offer_redeemed" });
  });

  it("a legacy gift row with no automation key falls back to the clicked automation, then to the offer key", () => {
    expect(resolveMarketingSource({
      redeemedOffer: { automationKey: null, offerKey: "winback_60_free_ghkcu" },
      automationClick: { key: "winback_60", clickedAtMs: T },
    })).toEqual({ kind: "automation", ref: "winback_60", basis: "offer_redeemed" });
    expect(resolveMarketingSource({
      redeemedOffer: { automationKey: null, offerKey: "winback_60_free_ghkcu" },
    })).toEqual({ kind: "automation", ref: "offer:winback_60_free_ghkcu", basis: "offer_redeemed" });
  });

  it("with two clicks the LATER one wins", () => {
    expect(resolveMarketingSource({
      automationClick: { key: "winback_30", clickedAtMs: T },
      campaignClick: { campaignId: "camp-1", clickedAtMs: T + 1 },
    })).toEqual({ kind: "campaign", ref: "camp-1", basis: "click" });
    expect(resolveMarketingSource({
      automationClick: { key: "winback_30", clickedAtMs: T + 1 },
      campaignClick: { campaignId: "camp-1", clickedAtMs: T },
    })).toEqual({ kind: "automation", ref: "winback_30", basis: "click" });
  });

  it("an exact tie between clicks goes to the automation, the more specific message", () => {
    expect(resolveMarketingSource({
      automationClick: { key: "replenishment", clickedAtMs: T },
      campaignClick: { campaignId: "camp-1", clickedAtMs: T },
    })).toEqual({ kind: "automation", ref: "replenishment", basis: "click" });
  });

  it("an automation click with an unknown key is ignored, not credited", () => {
    expect(resolveMarketingSource({
      automationClick: { key: "not_a_real_automation", clickedAtMs: T },
      campaignClick: { campaignId: "camp-1", clickedAtMs: T - 1 },
    })).toEqual({ kind: "campaign", ref: "camp-1", basis: "click" });
  });

  it("a click beats a cart-recovery coupon, which beats an ambassador code, which beats an ad touch", () => {
    expect(resolveMarketingSource({
      campaignClick: { campaignId: "camp-1", clickedAtMs: T },
      recoveryCoupon: { code: "SAVE-ABC" },
      ambassadorId: "amb-1",
      adTouch: { source: "tiktok", campaign: null, clickId: null },
    })).toEqual({ kind: "campaign", ref: "camp-1", basis: "click" });
    expect(resolveMarketingSource({
      recoveryCoupon: { code: "SAVE-ABC" },
      ambassadorId: "amb-1",
      adTouch: { source: "tiktok", campaign: null, clickId: null },
    })).toEqual({ kind: "cart_recovery", ref: "SAVE-ABC", basis: "recovery_coupon" });
    expect(resolveMarketingSource({
      ambassadorId: "amb-1",
      adTouch: { source: "tiktok", campaign: null, clickId: null },
    })).toEqual({ kind: "ambassador", ref: "amb-1", basis: "referral_code" });
    expect(resolveMarketingSource({
      adTouch: { source: "tiktok", campaign: "spring", clickId: "ttclid" },
    })).toEqual({ kind: "ad", ref: "spring", basis: "ad_touch" });
  });

  it("an ad touch with nothing in it is not an ad touch", () => {
    expect(resolveMarketingSource({ adTouch: { source: null, campaign: null, clickId: null } }))
      .toEqual({ kind: "organic", ref: null, basis: "none" });
  });

  it("nothing at all is organic", () => {
    expect(resolveMarketingSource({})).toEqual({ kind: "organic", ref: null, basis: "none" });
  });
});

describe("mayReplaceMarketingSource: credit is written once, with one upgrade", () => {
  it("writes freely onto an unstamped order", () => {
    expect(mayReplaceMarketingSource({ kind: null, basis: null }, { kind: "organic", ref: null, basis: "none" })).toBe(true);
  });

  it("upgrades a click stamp to a redeemed gift", () => {
    expect(mayReplaceMarketingSource({ kind: "campaign", basis: "click" }, { kind: "automation", ref: "winback_30", basis: "offer_redeemed" })).toBe(true);
  });

  it("never moves credit for any other reason", () => {
    expect(mayReplaceMarketingSource({ kind: "campaign", basis: "click" }, { kind: "cart_recovery", ref: "SAVE-1", basis: "recovery_coupon" })).toBe(false);
    expect(mayReplaceMarketingSource({ kind: "automation", basis: "offer_redeemed" }, { kind: "automation", ref: "other", basis: "offer_redeemed" })).toBe(false);
    expect(mayReplaceMarketingSource({ kind: "organic", basis: "none" }, { kind: "campaign", ref: "camp-1", basis: "click" })).toBe(false);
  });
});
