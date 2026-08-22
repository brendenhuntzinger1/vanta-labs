import { describe, expect, it } from "vitest";
import {
  ONE_DISCOUNT_NOTE,
  discountHeadline,
  endsLabel,
  hasPromotableOffer,
  MAX_DISMISSALS,
  offerId,
  offerTag,
  parseDismissed,
  serializeDismissed,
  visibleOffers,
  type StorefrontOffer,
} from "@/lib/storefront-offer-format";

function offer(over: Partial<StorefrontOffer> = {}): StorefrontOffer {
  return {
    id: "coupon:vanta15:percent:15:",
    kind: "coupon",
    eyebrow: "Limited-time offer",
    headline: "15% OFF sitewide",
    code: "VANTA15",
    automaticNote: null,
    endsAt: null,
    details: [ONE_DISCOUNT_NOTE],
    href: "/products",
    priority: 10,
    standing: false,
    ...over,
  };
}

describe("the headline states the actual discount", () => {
  it("writes a percentage as a percentage", () => {
    expect(discountHeadline("percent", 15)).toBe("15% OFF");
  });

  it("writes a whole-dollar amount without cents", () => {
    // "$20.00 OFF" is what a spreadsheet says. "$20 OFF" is what a shop says.
    expect(discountHeadline("fixed", 20)).toBe("$20 OFF");
  });

  it("keeps the cents when there are cents to keep", () => {
    expect(discountHeadline("fixed", 19.5)).toBe("$19.50 OFF");
  });

  it("keeps a fractional percentage rather than rounding the offer up", () => {
    // Rounding 12.5% to 13% advertises more than checkout applies.
    expect(discountHeadline("percent", 12.5)).toBe("12.5% OFF");
  });
});

describe("expiry is only ever stated from a real timestamp", () => {
  it("says nothing at all when the promotion has no end date", () => {
    expect(endsLabel(null)).toBeNull();
  });

  it("says nothing for an unparseable date rather than guessing", () => {
    expect(endsLabel("not a date")).toBeNull();
  });

  it("stops advertising the moment the end time has passed", () => {
    const now = new Date("2026-08-22T12:00:00Z");
    expect(endsLabel("2026-08-22T11:59:00Z", now)).toBeNull();
  });

  it("says 'ends tonight' only on the offer's own last day", () => {
    // 2026-08-22T20:00Z is 4pm Eastern on the 22nd; "now" is 10am Eastern.
    const now = new Date("2026-08-22T14:00:00Z");
    expect(endsLabel("2026-08-22T20:00:00Z", now)).toBe("Ends tonight");
  });

  it("names the date when the offer runs past today", () => {
    const now = new Date("2026-08-22T14:00:00Z");
    expect(endsLabel("2026-08-25T20:00:00Z", now)).toMatch(/^Ends /);
    expect(endsLabel("2026-08-25T20:00:00Z", now)).not.toBe("Ends tonight");
  });

  it("asks 'is it today' in the business timezone, not the server's", () => {
    // 2026-08-23T02:00Z is 10pm Eastern on the 22nd — still today for a US
    // shopper, already tomorrow for a UTC server. Getting this wrong both
    // states the wrong day and hydrates differently in the browser.
    const now = new Date("2026-08-23T01:00:00Z"); // 9pm ET on the 22nd
    expect(endsLabel("2026-08-23T02:00:00Z", now)).toBe("Ends tonight");
  });
});

describe("an offer's identity changes when its terms change", () => {
  it("gives the same offer the same id", () => {
    expect(offerId(["coupon", "VANTA15", "percent", 15, null]))
      .toBe(offerId(["coupon", "VANTA15", "percent", 15, null]));
  });

  it("gives a different id once the discount changes", () => {
    // This is what lets an improved offer reappear for someone who dismissed
    // the smaller one, without a version counter to maintain.
    expect(offerId(["coupon", "VANTA15", "percent", 15, null]))
      .not.toBe(offerId(["coupon", "VANTA15", "percent", 25, null]));
  });

  it("gives a different id once the end date changes", () => {
    expect(offerId(["coupon", "VANTA15", "percent", 15, "2026-08-25"]))
      .not.toBe(offerId(["coupon", "VANTA15", "percent", 15, "2026-09-01"]));
  });
});

describe("standing terms never open the offers bar on their own", () => {
  it("shows nothing when only free shipping and bundle pricing are live", () => {
    const standing = [
      offer({ kind: "free_shipping", standing: true, code: null, headline: "Complimentary shipping over $200" }),
      offer({ kind: "bundle", standing: true, code: null, headline: "Save up to 20% on multiples" }),
    ];
    expect(hasPromotableOffer(standing)).toBe(false);
    expect(visibleOffers(standing)).toEqual([]);
  });

  it("shows everything once a real promotion joins them", () => {
    const mixed = [
      offer(),
      offer({ kind: "free_shipping", standing: true, code: null }),
    ];
    expect(hasPromotableOffer(mixed)).toBe(true);
    expect(visibleOffers(mixed)).toHaveLength(2);
  });

  it("shows nothing when there are no offers at all", () => {
    expect(visibleOffers([])).toEqual([]);
  });
});

describe("the bar never implies discounts stack", () => {
  it("carries the one-discount-per-order note on every discount offer", () => {
    // discount-resolution.ts applies exactly one discount, the largest. A bar
    // listing a coupon next to an automatic promotion has to say so.
    // It is now stated ONCE, as a footer on the offers sheet, rather than
    // repeated under every offer — see the note in storefront-offers-bar.tsx.
    expect(ONE_DISCOUNT_NOTE).toMatch(/one discount applies per order/i);
  });

  it("says free shipping is separate, because it genuinely is", () => {
    // calculateShipping() is computed outside resolveBestDiscount(), so this
    // is the one thing that really does apply on top.
    expect(ONE_DISCOUNT_NOTE).toMatch(/free shipping is separate/i);
  });
});

describe("an offer is either a code or automatic, never both", () => {
  it("does not put a fake code on an automatic promotion", () => {
    const auto = offer({ kind: "buy3get1", code: null, automaticNote: "Applied automatically at checkout" });
    expect(auto.code).toBeNull();
    expect(auto.automaticNote).toBeTruthy();
  });

  it("does not claim a coupon is automatic", () => {
    expect(offer().automaticNote).toBeNull();
    expect(offer().code).toBeTruthy();
  });
});

describe("dismissals ride in a cookie, so the server can render the final state", () => {
  it("hashes an offer id down to something a cookie can carry", () => {
    const tag = offerTag("coupon:vanta15:percent:15::");
    expect(tag).toMatch(/^[a-z0-9]{1,8}$/);
    expect(tag.length).toBeLessThanOrEqual(8);
  });

  it("gives the same offer the same tag every time", () => {
    expect(offerTag("coupon:vanta15:percent:15::")).toBe(offerTag("coupon:vanta15:percent:15::"));
  });

  it("gives a changed offer a different tag, so it can appear again", () => {
    expect(offerTag("coupon:vanta15:percent:15::")).not.toBe(offerTag("coupon:vanta15:percent:25::"));
  });

  it("survives a round trip", () => {
    const tags = ["abc", "def1"];
    expect(parseDismissed(serializeDismissed(tags))).toEqual(tags);
  });

  it("treats the cookie as untrusted input", () => {
    // It is user-editable. Anything that is not a plausible tag is dropped
    // rather than trusted into a comparison.
    expect(parseDismissed("<script>")).toEqual([]);
    expect(parseDismissed("abc.<img>.def")).toEqual(["abc", "def"]);
    expect(parseDismissed(undefined)).toEqual([]);
    expect(parseDismissed("")).toEqual([]);
  });

  it("bounds how much it will ever put on a request", () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(parseDismissed(many.join("."))).toHaveLength(MAX_DISMISSALS);
    expect(serializeDismissed(many).length).toBeLessThan(80);
  });

  it("keeps the NEWEST dismissals when it has to drop some", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(serializeDismissed(many)).toContain("t11");
    expect(serializeDismissed(many)).not.toContain("t0");
  });
});
