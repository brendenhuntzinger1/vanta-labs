import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_WINDOW_DAYS,
  emptyAttributionRecord,
  hasAnyAttribution,
  hasCampaignEvidence,
  hasPaidClickId,
  isTouchExpired,
  mergeAttribution,
  parseAttributionTouch,
  sanitizeAttributionRecord,
  toAnalyticsAttribution,
  toOrderAttributionRow,
  type AttributionTouch,
} from "@/lib/attribution";

// Every test here defends the same invariant from a different angle: a sale is
// credited to an ad ONLY when the visit carried evidence of an ad. The cost of
// getting this wrong is not a wrong number on a dashboard — it is an optimiser
// scaling a campaign that never sold anything, with real money.

const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("parseAttributionTouch", () => {
  it("captures a TikTok paid click with its full campaign tagging", () => {
    const touch = parseAttributionTouch({
      search: "?ttclid=EABC123xyz&utm_source=tiktok&utm_medium=paid_social&utm_campaign=bpc_launch&utm_content=hook_a&utm_term=peptide",
      pathname: "/products/bpc-157",
      referrer: "https://www.tiktok.com/",
      now: NOW,
    });

    expect(touch).not.toBeNull();
    expect(touch!.ttclid).toBe("EABC123xyz");
    expect(touch!.utmSource).toBe("tiktok");
    expect(touch!.utmMedium).toBe("paid_social");
    expect(touch!.utmCampaign).toBe("bpc_launch");
    expect(touch!.utmContent).toBe("hook_a");
    expect(touch!.utmTerm).toBe("peptide");
    expect(touch!.landingPath).toBe("/products/bpc-157");
    expect(touch!.at).toBe(NOW.toISOString());
    expect(hasPaidClickId(touch)).toBe(true);
  });

  it("captures Meta and Google click ids through the same path", () => {
    expect(parseAttributionTouch({ search: "?fbclid=fb_abc", now: NOW })!.fbclid).toBe("fb_abc");
    expect(parseAttributionTouch({ search: "?gclid=g_abc", now: NOW })!.gclid).toBe("g_abc");
  });

  it("captures Reddit and Snapchat click ids, the other two platforms actually running", () => {
    const reddit = parseAttributionTouch({ search: "?rdt_cid=rd_abc", now: NOW });
    expect(reddit!.rdtCid).toBe("rd_abc");
    expect(hasPaidClickId(reddit)).toBe(true);

    const snap = parseAttributionTouch({ search: "?ScCid=sc_abc", now: NOW });
    expect(snap!.scCid).toBe("sc_abc");
    expect(hasPaidClickId(snap)).toBe(true);
  });

  // Snapchat documents `ScCid` but sends `sccid` and `SCCID` too, depending on
  // which surface built the link. A case-exact read drops the click id from a
  // real paid visit, which presents as "Snapchat doesn't convert".
  it("reads Snapchat's click id whatever case it arrives in", () => {
    for (const key of ["ScCid", "sccid", "SCCID", "scCid"]) {
      const touch = parseAttributionTouch({ search: `?${key}=sc_1`, now: NOW });
      expect(touch, key).not.toBeNull();
      expect(touch!.scCid, key).toBe("sc_1");
    }
  });

  // Reddit's parameter is not case-flexible in the wild, and accepting variants
  // would mean accepting `RDT_CID` from a source that isn't Reddit.
  it("does not invent a Reddit click id from a bare visit", () => {
    expect(parseAttributionTouch({ search: "?page=2", now: NOW })).toBeNull();
  });

  // THE CENTRAL RULE. A bare visit is not an ad click.
  it("returns null for an organic visit rather than inventing a touch", () => {
    expect(parseAttributionTouch({ search: "", pathname: "/products", now: NOW })).toBeNull();
    expect(parseAttributionTouch({ search: "?", pathname: "/", now: NOW })).toBeNull();
    expect(parseAttributionTouch({ search: "?page=2&sort=price", pathname: "/products", now: NOW })).toBeNull();
  });

  // The subtlest way to over-credit paid: someone arrives FROM tiktok.com but
  // via a bio link or a friend's repost. That is organic, and calling it paid
  // would quietly inflate every campaign that happens to be running.
  it("refuses to treat a social referrer alone as ad attribution", () => {
    expect(parseAttributionTouch({ search: "", pathname: "/products/bpc-157", referrer: "https://www.tiktok.com/@someone", now: NOW })).toBeNull();
    expect(parseAttributionTouch({ search: "", referrer: "https://www.facebook.com/", now: NOW })).toBeNull();
    expect(parseAttributionTouch({ search: "", referrer: "https://www.google.com/search?q=vanta+labs", now: NOW })).toBeNull();
  });

  it("keeps the referrer as context when a real touch exists", () => {
    const touch = parseAttributionTouch({ search: "?utm_source=tiktok", referrer: "https://www.tiktok.com/", now: NOW });
    expect(touch!.referrer).toBe("https://www.tiktok.com/");
  });

  it("rejects an off-site landing path and a non-http referrer", () => {
    const touch = parseAttributionTouch({
      search: "?ttclid=x",
      pathname: "https://evil.example/products",
      referrer: "javascript:alert(1)",
      now: NOW,
    });
    expect(touch!.landingPath).toBeNull();
    expect(touch!.referrer).toBeNull();
  });

  it("strips control characters and caps absurd values", () => {
    const touch = parseAttributionTouch({ search: `?utm_campaign=${encodeURIComponent("a\x00b\x1Fc")}&ttclid=${"x".repeat(900)}`, now: NOW });
    expect(touch!.utmCampaign).toBe("a b c");
    expect(touch!.ttclid!.length).toBe(512);
  });
});

describe("mergeAttribution", () => {
  const tiktok = parseAttributionTouch({ search: "?utm_source=tiktok&ttclid=t1", now: daysAgo(10) })!;
  const meta = parseAttributionTouch({ search: "?utm_source=meta&fbclid=f1", now: NOW })!;

  it("defends first touch and advances last touch", () => {
    const first = mergeAttribution(null, tiktok, { now: daysAgo(10), visitorId: "v1", sessionId: "s1" });
    expect(first.first?.utmSource).toBe("tiktok");
    expect(first.last?.utmSource).toBe("tiktok");

    const second = mergeAttribution(first, meta, { now: NOW, visitorId: "v1", sessionId: "s2" });
    // The campaign that FOUND them is not overwritten by the one that closed them.
    expect(second.first?.utmSource).toBe("tiktok");
    expect(second.last?.utmSource).toBe("meta");
    expect(second.sessionId).toBe("s2");
  });

  it("keeps identity while recording no campaign on an organic page view", () => {
    const record = mergeAttribution(null, null, { now: NOW, visitorId: "v9", sessionId: "s9" });
    expect(record.visitorId).toBe("v9");
    expect(record.first).toBeNull();
    expect(record.last).toBeNull();
    expect(hasAnyAttribution(record)).toBe(true); // identity alone is still worth storing
    expect(hasCampaignEvidence(record.last)).toBe(false); // but it is NOT a campaign
  });

  // A click from months ago must not be able to claim today's sale.
  it("drops touches that have aged out of the window", () => {
    const stale = mergeAttribution(null, tiktok, { now: daysAgo(90), visitorId: "v1" });
    const fresh = mergeAttribution({ ...stale, first: { ...tiktok, at: daysAgo(90).toISOString() }, last: { ...tiktok, at: daysAgo(90).toISOString() } }, null, { now: NOW });
    expect(fresh.first).toBeNull();
    expect(fresh.last).toBeNull();
  });

  it("treats the window boundary consistently", () => {
    const inside: AttributionTouch = { ...tiktok, at: daysAgo(ATTRIBUTION_WINDOW_DAYS - 1).toISOString() };
    const outside: AttributionTouch = { ...tiktok, at: daysAgo(ATTRIBUTION_WINDOW_DAYS + 1).toISOString() };
    expect(isTouchExpired(inside, NOW)).toBe(false);
    expect(isTouchExpired(outside, NOW)).toBe(true);
  });

  it("treats an unparseable timestamp as expired rather than valid", () => {
    expect(isTouchExpired({ ...tiktok, at: "not-a-date" }, NOW)).toBe(true);
  });
});

describe("sanitizeAttributionRecord — the client is not trusted", () => {
  it("accepts a well-formed record", () => {
    const record = sanitizeAttributionRecord(
      {
        visitorId: "v1",
        sessionId: "s1",
        first: { utmSource: "tiktok", ttclid: "t1", at: daysAgo(3).toISOString() },
        last: { utmSource: "tiktok", ttclid: "t2", at: NOW.toISOString() },
      },
      NOW,
    );
    expect(record!.first!.ttclid).toBe("t1");
    expect(record!.last!.ttclid).toBe("t2");
  });

  // A crafted checkout POST must not be able to manufacture an attributed sale.
  it("discards a fabricated touch that carries no campaign evidence", () => {
    const record = sanitizeAttributionRecord(
      { visitorId: "v1", last: { landingPath: "/products", referrer: "https://tiktok.com/", at: NOW.toISOString() } },
      NOW,
    );
    expect(record!.last).toBeNull();
    expect(record!.visitorId).toBe("v1");
  });

  // Otherwise a payload could mint a touch that never ages out.
  it("clamps a future timestamp to now", () => {
    const future = new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 365).toISOString();
    const record = sanitizeAttributionRecord({ last: { utmSource: "tiktok", at: future } }, NOW);
    expect(record!.last!.at).toBe(NOW.toISOString());
  });

  it("drops an already-expired touch supplied by the client", () => {
    const record = sanitizeAttributionRecord({ last: { utmSource: "tiktok", at: daysAgo(200).toISOString() } }, NOW);
    expect(record).toBeNull();
  });

  it("returns null for junk, so nothing is written at all", () => {
    expect(sanitizeAttributionRecord(null, NOW)).toBeNull();
    expect(sanitizeAttributionRecord("tiktok", NOW)).toBeNull();
    expect(sanitizeAttributionRecord({}, NOW)).toBeNull();
    expect(sanitizeAttributionRecord({ first: {}, last: {} }, NOW)).toBeNull();
  });
});

describe("storage mapping", () => {
  it("flattens first and last touch into the column layout", () => {
    const record = mergeAttribution(
      mergeAttribution(null, parseAttributionTouch({ search: "?utm_source=tiktok&ttclid=t1", now: daysAgo(5) }), { now: daysAgo(5), visitorId: "v1", sessionId: "s1" }),
      parseAttributionTouch({ search: "?utm_source=meta&fbclid=f1", now: NOW }),
      { now: NOW, sessionId: "s2" },
    );

    const row = toOrderAttributionRow("order-123", record);
    expect(row.order_id).toBe("order-123");
    expect(row.visitor_id).toBe("v1");
    expect(row.session_id).toBe("s2");
    expect(row.first_utm_source).toBe("tiktok");
    expect(row.first_ttclid).toBe("t1");
    expect(row.last_utm_source).toBe("meta");
    expect(row.last_fbclid).toBe("f1");
    expect(row.last_ttclid).toBeNull();
  });

  it("flattens Reddit and Snapchat click ids onto their own columns", () => {
    const record = mergeAttribution(
      null,
      parseAttributionTouch({ search: "?utm_source=reddit&rdt_cid=rd1&ScCid=sc1", now: NOW }),
      { now: NOW, visitorId: "v1" },
    );
    const row = toOrderAttributionRow("order-789", record);
    expect(row.last_rdt_cid).toBe("rd1");
    expect(row.last_sccid).toBe("sc1");
    expect(row.first_rdt_cid).toBe("rd1");
    expect(row.first_sccid).toBe("sc1");
  });

  it("emits nulls for an identity-only record instead of guessing a campaign", () => {
    const row = toOrderAttributionRow("order-456", { ...emptyAttributionRecord(), visitorId: "v1" });
    expect(row.first_utm_source).toBeNull();
    expect(row.last_utm_source).toBeNull();
    expect(row.first_touch_at).toBeNull();
    expect(row.last_touch_at).toBeNull();
  });

  // What the purchase event in website_analytics_events receives.
  it("reports last touch to analytics, and nulls when unattributed", () => {
    const attributed = mergeAttribution(null, parseAttributionTouch({ search: "?utm_source=tiktok&utm_medium=paid_social&utm_campaign=c1", now: NOW }), { now: NOW, visitorId: "v1" });
    expect(toAnalyticsAttribution(attributed)).toEqual({
      utm_source: "tiktok",
      utm_medium: "paid_social",
      utm_campaign: "c1",
      visitor_id: "v1",
    });

    expect(toAnalyticsAttribution(null)).toEqual({
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      visitor_id: null,
    });
  });
});
