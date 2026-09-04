import { describe, expect, it } from "vitest";
import {
  LABOR_DAY_2026,
  activeSeasonalCampaign,
  brandOffersForSeason,
} from "@/lib/labor-day-campaign";
import { ONE_DISCOUNT_NOTE, type StorefrontOffer } from "@/lib/storefront-offer-format";

function offer(over: Partial<StorefrontOffer> = {}): StorefrontOffer {
  return {
    id: "bxgy:buy-2-get-1-free:2:1:100",
    kind: "buy3get1",
    eyebrow: "Automatic offer",
    headline: "Buy 2 Get 1 Free",
    code: null,
    automaticNote: "Applied automatically at checkout",
    endsAt: null,
    details: [ONE_DISCOUNT_NOTE],
    href: "/products",
    priority: 30,
    standing: false,
    ...over,
  };
}

/** Inside the window: Labor Day itself, Monday 7 September 2026, midday Eastern. */
const DURING = new Date("2026-09-07T16:00:00Z");

/** The wording on the band. One constant, so a copy change is one edit. */
const EYEBROW = "Labor Day Sale";

describe("the campaign window is anchored to the store's business day", () => {
  it("is open on the first morning, 4 September, Eastern", () => {
    // 00:30 EDT on the 4th. In UTC that is already 04:30 the same day; the
    // point of the fixture is that a UTC-brained boundary would call this
    // "before the sale" for the first four hours of the first day.
    expect(activeSeasonalCampaign(new Date("2026-09-04T04:30:00Z"))).toEqual(LABOR_DAY_2026);
  });

  it("is shut a minute before the sale opens", () => {
    // 23:59 EDT on 3 September.
    expect(activeSeasonalCampaign(new Date("2026-09-04T03:59:00Z"))).toBeNull();
  });

  it("is open late on the last night, 13 September, Eastern", () => {
    // 23:30 EDT on the 13th — still the 13th for a shopper, already the 14th in
    // UTC. This is the boundary the store owner set: "midnight the 13th",
    // meaning the banner survives all of Sunday and goes at midnight after it.
    expect(activeSeasonalCampaign(new Date("2026-09-14T03:30:00Z"))).toEqual(LABOR_DAY_2026);
  });

  it("is still open through the middle of the run, 10 September", () => {
    // The window used to close on the 9th. Nothing about that date is special
    // any more, and this is the case that would have caught it silently.
    expect(activeSeasonalCampaign(new Date("2026-09-10T16:00:00Z"))).toEqual(LABOR_DAY_2026);
  });

  it("is shut once the 13th is over", () => {
    // 00:30 EDT on 14 September.
    expect(activeSeasonalCampaign(new Date("2026-09-14T04:30:00Z"))).toBeNull();
  });

  it("is shut a year later, so the banner cannot come back on its own", () => {
    expect(activeSeasonalCampaign(new Date("2027-09-07T16:00:00Z"))).toBeNull();
  });
});

describe("exactly one offer wears the campaign", () => {
  it("brands the leading promotion and nothing else", () => {
    // The store owner runs ONE sale. If a second promotion is live anyway,
    // only the one the bar actually leads with may call itself Labor Day —
    // two Labor Day headlines in one bar is two sales to a reader.
    const branded = brandOffersForSeason(
      [offer({ id: "a", priority: 10 }), offer({ id: "b", priority: 30 })],
      LABOR_DAY_2026,
    );
    expect(branded.map((o) => o.theme)).toEqual(["americana", undefined]);
    expect(branded.filter((o) => o.eyebrow === LABOR_DAY_2026.eyebrow)).toHaveLength(1);
  });

  it("takes the list in the order it is given rather than re-sorting it", () => {
    // storefront-offers has already sorted by priority. Sorting again here
    // would be a second opinion about which offer leads, and the bar renders
    // the first element — so the two could disagree.
    const branded = brandOffersForSeason([offer({ id: "b" }), offer({ id: "a" })], LABOR_DAY_2026);
    expect(branded[0].id).toContain("b");
  });

  it("re-titles the eyebrow and leaves the headline strictly alone", () => {
    // The headline is the discount. It comes from the system that enforces it,
    // and a seasonal theme has no business rewriting it.
    const [branded] = brandOffersForSeason([offer()], LABOR_DAY_2026);
    expect(branded.eyebrow).toBe(EYEBROW);
    expect(branded.headline).toBe("Buy 2 Get 1 Free");
  });

  it("changes the id so a shopper who dismissed the plain offer sees the dressed one", () => {
    const [branded] = brandOffersForSeason([offer()], LABOR_DAY_2026);
    expect(branded.id).not.toBe(offer().id);
    expect(branded.id).toContain("labor-day-2026");
  });

  it("leaves the discount, the code and the end date untouched", () => {
    // The banner reflects the promotion. It never invents one.
    const source = offer({ code: "LABORDAY", automaticNote: null, endsAt: "2026-09-09T03:59:00Z" });
    const [branded] = brandOffersForSeason([source], LABOR_DAY_2026);
    expect(branded.code).toBe("LABORDAY");
    expect(branded.endsAt).toBe("2026-09-09T03:59:00Z");
    expect(branded.details).toEqual(source.details);
  });
});

describe("standing terms are never a Labor Day sale", () => {
  it("skips free shipping and quantity pricing when picking what to brand", () => {
    // These are always on. Dressing "complimentary shipping over $200" as a
    // Labor Day sale advertises a holiday discount that does not exist.
    const branded = brandOffersForSeason(
      [
        offer({ id: "ship", kind: "free_shipping", standing: true, priority: 80 }),
        offer({ id: "promo", priority: 30 }),
      ],
      LABOR_DAY_2026,
    );
    expect(branded.find((o) => o.id.startsWith("ship"))?.theme).toBeUndefined();
    expect(branded.find((o) => o.id.startsWith("promo"))?.theme).toBe("americana");
  });

  it("brands nothing at all when only standing terms are live", () => {
    // No sale is running, so there is no Labor Day sale to advertise. The bar
    // does not open for standing terms anyway (hasPromotableOffer), and this
    // is the second guarantee: even if it did, it would not wear a flag.
    const branded = brandOffersForSeason(
      [offer({ kind: "free_shipping", standing: true })],
      LABOR_DAY_2026,
    );
    expect(branded.every((o) => o.theme === undefined)).toBe(true);
  });

  it("brands nothing when there are no offers", () => {
    expect(brandOffersForSeason([], LABOR_DAY_2026)).toEqual([]);
  });
});

describe("outside the window nothing is touched", () => {
  it("returns the offers exactly as given when no campaign is running", () => {
    const offers = [offer()];
    expect(brandOffersForSeason(offers, null)).toEqual(offers);
  });

  it("leaves the ordinary eyebrow in place out of season", () => {
    const [plain] = brandOffersForSeason([offer()], activeSeasonalCampaign(new Date("2026-10-01T16:00:00Z")));
    expect(plain.eyebrow).toBe("Automatic offer");
    expect(plain.theme).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE THREE STATES THE STORE OWNER CAN PUT THE SHOP IN.
//
// One sale runs at a time: Buy 2 Get 1 Free in the promotion centre, OR 20% off
// sitewide as the LABORDAY coupon, OR neither. The offers below are the exact
// shapes storefront-offers.ts builds for each (a bxgy offer at priority 30, a
// coupon offer at priority 10), so what is measured here is the banner a
// shopper gets for each position of the admin toggles.
//
// The wiring from Supabase to these shapes is proved in the browser, not here —
// resolveStorefrontOffers reads the live tables. What this pins is the half that
// can silently regress: which offer gets dressed, and what it then says.
// ---------------------------------------------------------------------------
const BUY_2_GET_1 = offer({
  id: "bxgy:buy-2-get-1-free:2:1:100",
  headline: "Buy 2 Get 1 Free",
  priority: 30,
});
const TWENTY_OFF = offer({
  id: "coupon:laborday:percent:20:",
  kind: "coupon",
  eyebrow: "Limited-time offer",
  headline: "20% OFF sitewide",
  code: "LABORDAY",
  automaticNote: null,
  priority: 10,
});

describe("the banner advertises whichever sale is actually switched on", () => {
  it("says Buy 2 Get 1 Free when that is the promotion that is live", () => {
    const [banner] = brandOffersForSeason([BUY_2_GET_1], activeSeasonalCampaign(DURING));
    expect(banner.theme).toBe("americana");
    expect(banner.eyebrow).toBe(EYEBROW);
    expect(banner.headline).toBe("Buy 2 Get 1 Free");
    expect(banner.automaticNote).toBe("Applied automatically at checkout");
    expect(banner.code).toBeNull();
  });

  it("says 20% OFF sitewide when the toggle is flipped to the coupon instead", () => {
    // The SAME banner, no second component and no second theme — the only
    // thing that changed is which offer reached it.
    const [banner] = brandOffersForSeason([TWENTY_OFF], activeSeasonalCampaign(DURING));
    expect(banner.theme).toBe("americana");
    expect(banner.eyebrow).toBe(EYEBROW);
    expect(banner.headline).toBe("20% OFF sitewide");
    expect(banner.code).toBe("LABORDAY");
  });

  it("advertises no Labor Day sale at all when both are switched off", () => {
    // Only standing terms left. The bar does not open for these (see
    // hasPromotableOffer) and, if it somehow did, nothing here would call a
    // shipping policy a Labor Day sale.
    const standing = [
      offer({ id: "free_shipping:200", kind: "free_shipping", headline: "Complimentary shipping over $200", standing: true, priority: 80 }),
      offer({ id: "bundle:3", kind: "bundle", headline: "Save up to 12% on 3+", standing: true, priority: 90 }),
    ];
    const branded = brandOffersForSeason(standing, activeSeasonalCampaign(DURING));
    expect(branded.every((o) => o.theme === undefined)).toBe(true);
    expect(branded.every((o) => o.eyebrow !== EYEBROW)).toBe(true);
  });

  it("dresses only the leading sale if both are somehow left on at once", () => {
    // Not the intended workflow, but a mis-click should degrade to one clear
    // sale rather than two competing Labor Day headlines. The coupon leads on
    // priority, so it is the one that wears the flag.
    const branded = brandOffersForSeason([TWENTY_OFF, BUY_2_GET_1], activeSeasonalCampaign(DURING));
    expect(branded.filter((o) => o.theme === "americana")).toHaveLength(1);
    expect(branded[0].headline).toBe("20% OFF sitewide");
    expect(branded[1].eyebrow).toBe("Automatic offer");
  });

  it("never rewrites what checkout will charge, in any state", () => {
    // The one guarantee that matters more than the paint: branding may not
    // touch a discount, a code, a deadline or the terms behind DETAILS.
    for (const source of [BUY_2_GET_1, TWENTY_OFF]) {
      const [banner] = brandOffersForSeason([source], activeSeasonalCampaign(DURING));
      expect(banner.headline).toBe(source.headline);
      expect(banner.code).toBe(source.code);
      expect(banner.endsAt).toBe(source.endsAt);
      expect(banner.details).toEqual(source.details);
      expect(banner.priority).toBe(source.priority);
      expect(banner.standing).toBe(source.standing);
    }
  });
});

describe("the campaign describes itself honestly", () => {
  it("is dated to the window the store owner asked for", () => {
    expect(activeSeasonalCampaign(DURING)).not.toBeNull();
    expect(LABOR_DAY_2026.id).toBe("labor-day-2026");
  });

  it("carries no discount of its own", () => {
    // Deliberate: a campaign that could state a percentage would be a second
    // source of truth for the price. It owns words and paint, nothing else.
    expect(Object.keys(LABOR_DAY_2026).sort()).toEqual(["endsAt", "eyebrow", "id", "startsAt", "theme"]);
  });
});
