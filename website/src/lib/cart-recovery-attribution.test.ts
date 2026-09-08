import { describe, expect, it } from "vitest";
import { resolveMarketingSource } from "@/lib/marketing-source";
import {
  CART_RECOVERY_COOKIE,
  decodeCartRecoveryCookie,
  encodeCartRecoveryCookie,
  readCartRecoveryCookie,
} from "@/lib/email/cart-recovery-links";

// ---------------------------------------------------------------------------
// CART RECOVERY COULD NOT BE SHOWN TO WORK, EVEN WHEN IT WORKED.
//
// marketing-source.ts credits one channel per order and ranks the evidence
// `offer_redeemed > click > recovery_coupon > referral_code > ad_touch >
// organic`. Its click tier read the automation and campaign cookies only, so
// cart recovery appeared at exactly one rung: `recovery_coupon` — an order was
// credited to it ONLY IF IT SPENT A SAVE- CODE.
//
// Stages t30m, t12h and t24h carry no code. A shopper who clicked the first
// reminder and checked out ten minutes later was therefore recorded `organic`.
// Meanwhile `abandoned_carts.status = 'recovered'` is set by ANY paid order
// from that address inside the window, so the dashboard's recovery count
// included a customer who had received no email at all (Neil Hidalgo,
// 2026-09-06, zero sends). One number over-counted, the other under-counted,
// and neither answered "did the email cause this".
//
// The cookie below is the missing signal, and every ranking rule it takes part
// in is pinned here.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

describe("a cart-recovery click is a click, and ranks like one", () => {
  it("credits cart recovery for an order that followed the click, with no coupon in sight", () => {
    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 1_000 },
    })).toEqual({ kind: "cart_recovery", ref: "cart-1", basis: "click" });
  });

  it("beats the coupon tier, so a click is credited to the click that caused it", () => {
    // Both are cart recovery here, but the BASIS matters: a click proves the
    // email was the reason, a spent code only proves the code was accepted.
    const decision = resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 1_000 },
      recoveryCoupon: { code: "SAVE-ABC" },
    });
    expect(decision.basis).toBe("click");
  });

  it("outranks an ambassador code and an ad touch, exactly as the other clicks do", () => {
    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 1_000 },
      ambassadorId: "amb-1",
      adTouch: { source: "meta", campaign: "c", clickId: "x" },
    }).kind).toBe("cart_recovery");
  });

  // The gift token is proof rather than inference — only one email ever carried
  // it — so it still wins, and this is what stops a recovery click stealing
  // credit for a win-back gift the customer actually spent.
  it("loses to a redeemed gift token", () => {
    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 9_999 },
      redeemedOffer: { automationKey: "winback_60", offerKey: "winback_60_free_ghkcu" },
    }).basis).toBe("offer_redeemed");
  });
});

describe("last touch decides between the three click channels", () => {
  it.each([
    ["cart recovery clicked last", 3_000, 1_000, 2_000, "cart_recovery"],
    ["a campaign clicked last", 1_000, 2_000, 3_000, "campaign"],
    ["an automation clicked last", 1_000, 3_000, 2_000, "automation"],
  ])("%s wins", (_label, cartAt, autoAt, campaignAt, expected) => {
    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: cartAt as number },
      automationClick: { key: "winback_60", clickedAtMs: autoAt as number },
      campaignClick: { campaignId: "camp-1", clickedAtMs: campaignAt as number },
    }).kind).toBe(expected);
  });

  // A tie only happens when click times are unknown, and then the more
  // specific message is the better guess. This is the pre-existing rule; the
  // new channel is inserted between the two, not in front of them.
  it("on an exact tie the automation still wins, and cart recovery still beats a campaign", () => {
    expect(resolveMarketingSource({
      automationClick: { key: "winback_60", clickedAtMs: 5_000 },
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 5_000 },
      campaignClick: { campaignId: "camp-1", clickedAtMs: 5_000 },
    }).kind).toBe("automation");

    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "cart-1", clickedAtMs: 5_000 },
      campaignClick: { campaignId: "camp-1", clickedAtMs: 5_000 },
    }).kind).toBe("cart_recovery");
  });

  it("an empty cart id is not a click", () => {
    expect(resolveMarketingSource({
      cartRecoveryClick: { cartId: "", clickedAtMs: 5_000 },
      recoveryCoupon: { code: "SAVE-ABC" },
    }).basis).toBe("recovery_coupon");
  });
});

describe("nothing that used to be credited changes", () => {
  it.each([
    [{ automationClick: { key: "winback_60", clickedAtMs: 1 } }, "automation"],
    [{ campaignClick: { campaignId: "c", clickedAtMs: 1 } }, "campaign"],
    [{ recoveryCoupon: { code: "SAVE-X" } }, "cart_recovery"],
    [{ ambassadorId: "a" }, "ambassador"],
    [{ adTouch: { source: "meta", campaign: null, clickId: null } }, "ad"],
    [{}, "organic"],
  ])("%o still resolves to %s with no cart-recovery click present", (signals, expected) => {
    expect(resolveMarketingSource(signals).kind).toBe(expected);
  });
});

describe("the cookie", () => {
  it("round-trips", () => {
    const now = Date.now();
    expect(decodeCartRecoveryCookie(encodeCartRecoveryCookie("cart-1", now), now))
      .toEqual({ cartId: "cart-1", clickedAtMs: now });
  });

  // Enforced here as well as by Max-Age: a cookie lifetime is a request the
  // client may ignore, and attribution that can be extended by editing a cookie
  // is not attribution.
  it("expires after the seven-day window whatever the browser kept", () => {
    const now = Date.now();
    expect(decodeCartRecoveryCookie(encodeCartRecoveryCookie("cart-1", now - 6 * 24 * HOUR), now)).not.toBeNull();
    expect(decodeCartRecoveryCookie(encodeCartRecoveryCookie("cart-1", now - 8 * 24 * HOUR), now)).toBeNull();
  });

  it("refuses a click stamped in the future", () => {
    const now = Date.now();
    expect(decodeCartRecoveryCookie(encodeCartRecoveryCookie("cart-1", now + HOUR), now)).toBeNull();
  });

  it.each([undefined, null, "", "no-separator", ".1234", "cart-1.", "cart-1.notanumber"])(
    "reads %o as no click at all", (value) => {
      expect(decodeCartRecoveryCookie(value as string | null | undefined, Date.now())).toBeNull();
    });

  // A cart id may itself contain dots; the timestamp is the LAST segment.
  it("splits on the last separator so a dotted cart id survives", () => {
    const now = Date.now();
    expect(decodeCartRecoveryCookie(`a.b.c.${now}`, now)?.cartId).toBe("a.b.c");
  });

  it("has its own cookie name, never sharing a slot with the campaign one", () => {
    expect(CART_RECOVERY_COOKIE).toBe("vl_cart_recovery");
  });

  it("is read off a request beside the other cookies without picking up theirs", () => {
    const request = new Request("https://example.test", {
      headers: { cookie: `vl_campaign=camp-1.123; ${CART_RECOVERY_COOKIE}=cart-9.456; vl_offer=secret` },
    });
    expect(readCartRecoveryCookie(request)).toBe("cart-9.456");
  });

  it("returns null when the request carries no cookies at all", () => {
    expect(readCartRecoveryCookie(new Request("https://example.test"))).toBeNull();
  });
});
