import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";
import {
  hasCampaignEvidence,
  hasPaidClickId,
  mergeAttribution,
  parseAttributionTouch,
  toOrderAttributionRow,
  type AttributionRecord,
} from "@/lib/attribution";
import { safeInternalPath } from "@/lib/internal-path";

// ---------------------------------------------------------------------------
// A PAID CLICK MUST STILL BE A PAID CLICK ON THE OTHER SIDE OF THE ACCESS WALL.
//
// The store is closed by default, so no ad ever lands on the page it was aimed
// at: middleware answers a signed-out click with 307 to /account/login, and the
// original query string travels percent-encoded inside one `next` parameter.
//
// Nothing reads it there. site-analytics-tracker.tsx captures with
// `new URLSearchParams(window.location.search)`, which on the portal sees a
// single parameter named `next`, so BOTH stores recorded an untagged visit:
// website_analytics_events got the landing page_view with every utm column
// NULL, and vl_attribution got {"first":null,"last":null}. Reproduced on the
// harness before the fix — five parameters in, zero stored.
//
// The consequence is specific and expensive. A visitor who bounces at the
// portal is most of a cold paid click, and every one of them was stored
// indistinguishably from organic traffic. The ad was billed either way.
//
// These tests drive the REAL middleware and the REAL parser, and the seam
// between them is the same one the browser crosses: whatever ends up on the
// Location header is what `window.location.search` will hold. Nothing here
// re-implements the copy, so a regression in either half fails the test rather
// than being mirrored by it.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.vantalabsresearch.com";
const NOW = new Date("2026-09-06T12:00:00.000Z");

/** A signed-out ad click on a protected page — what the wall actually answers. */
async function adClick(pathAndQuery: string) {
  const response = await middleware(new NextRequest(`${ORIGIN}${pathAndQuery}`, { method: "GET" }));
  const location = new URL(response.headers.get("location") ?? "", ORIGIN);
  return { response, location };
}

/**
 * What the analytics tracker sees once the browser has followed that redirect.
 *
 * Deliberately built from `location.search` and `location.pathname` and nothing
 * else, because that is the tracker's entire input. If a parameter is not on
 * the URL, it does not exist as far as attribution is concerned.
 */
function captureAtPortal(location: URL, referrer: string | null) {
  return parseAttributionTouch({
    search: location.search,
    pathname: location.pathname,
    referrer,
    now: NOW,
  });
}

// The four platforms the store actually advertises on, plus Google, each with
// the click id that platform really appends. Table-driven so adding a platform
// is one row rather than a new copy of the funnel.
const PLATFORMS = [
  {
    name: "Meta (Facebook + Instagram)",
    utmSource: "facebook",
    clickIdKey: "fbclid",
    clickIdValue: "IwAR3Meta_Click_Id_0001",
    touchField: "fbclid",
    orderColumn: "first_fbclid",
    referrer: "https://l.facebook.com/",
  },
  {
    name: "TikTok",
    utmSource: "tiktok",
    clickIdKey: "ttclid",
    clickIdValue: "EABCtiktokClickId0002",
    touchField: "ttclid",
    orderColumn: "first_ttclid",
    referrer: "https://www.tiktok.com/",
  },
  {
    name: "Reddit",
    utmSource: "reddit",
    clickIdKey: "rdt_cid",
    clickIdValue: "reddit_click_id_0003",
    touchField: "rdtCid",
    orderColumn: "first_rdt_cid",
    referrer: "https://www.reddit.com/",
  },
  {
    name: "Snapchat",
    utmSource: "snapchat",
    clickIdKey: "ScCid",
    clickIdValue: "snap-click-id-0004",
    touchField: "scCid",
    orderColumn: "first_sccid",
    referrer: "https://www.snapchat.com/",
  },
  {
    name: "Google",
    utmSource: "google",
    clickIdKey: "gclid",
    clickIdValue: "Cj0KCQgoogleClickId5",
    touchField: "gclid",
    orderColumn: "first_gclid",
    referrer: "https://www.google.com/",
  },
] as const;

/** The tagged landing URL the admin ad-URL builder produces, for one platform. */
function landingUrl(platform: (typeof PLATFORMS)[number], path = "/products/recon-water") {
  const params = new URLSearchParams({
    utm_source: platform.utmSource,
    utm_medium: "paid_social",
    utm_campaign: "launch",
    utm_content: "hook_a",
    utm_term: "peptide",
    [platform.clickIdKey]: platform.clickIdValue,
  });
  return `${path}?${params.toString()}`;
}

describe("the access wall hands the portal a tagged URL", () => {
  it.each(PLATFORMS)("carries every $name parameter to the top level", async (platform) => {
    const { response, location } = await adClick(landingUrl(platform));

    expect(response.status).toBe(307);
    expect(location.pathname).toBe("/account/login");

    // The five campaign tags, readable WITHOUT unwrapping `next`. This is the
    // whole fix: before it, each of these was null.
    expect(location.searchParams.get("utm_source")).toBe(platform.utmSource);
    expect(location.searchParams.get("utm_medium")).toBe("paid_social");
    expect(location.searchParams.get("utm_campaign")).toBe("launch");
    expect(location.searchParams.get("utm_content")).toBe("hook_a");
    expect(location.searchParams.get("utm_term")).toBe("peptide");
    expect(location.searchParams.get(platform.clickIdKey)).toBe(platform.clickIdValue);
  });

  it("still carries the destination in next, unchanged", async () => {
    const { location } = await adClick(landingUrl(PLATFORMS[1]));
    // `next` keeps the FULL original query, so signing in resolves to exactly
    // what the ad pointed at — the picker in the ads admin still decides where
    // the visitor continues.
    expect(location.searchParams.get("next")).toBe(landingUrl(PLATFORMS[1]));
  });

  it.each(["/", "/products", "/products/recon-water"])(
    "sends %s to the same portal, so every ad destination has one arrival screen",
    async (path) => {
      const { response, location } = await adClick(landingUrl(PLATFORMS[1], path));
      expect(response.status).toBe(307);
      expect(location.pathname).toBe("/account/login");
      expect(location.searchParams.get("utm_campaign")).toBe("launch");
      expect(location.searchParams.get("next")).toBe(landingUrl(PLATFORMS[1], path));
    },
  );
});

// ---------------------------------------------------------------------------
// CASE 1 — THE VISITOR BOUNCES AT THE PORTAL AND NEVER SIGNS IN.
//
// The case that was completely dark before, and the majority of a cold paid
// click. Nothing beyond the landing page view ever happens, so if the touch is
// not captured here it is never captured at all.
// ---------------------------------------------------------------------------
describe("a visitor who bounces at the portal", () => {
  it.each(PLATFORMS)("is still attributed to the $name ad that paid for them", async (platform) => {
    const { location } = await adClick(landingUrl(platform));

    const touch = captureAtPortal(location, platform.referrer);

    expect(touch).not.toBeNull();
    expect(hasCampaignEvidence(touch)).toBe(true);
    expect(hasPaidClickId(touch)).toBe(true);
    expect(touch!.utmSource).toBe(platform.utmSource);
    expect(touch!.utmMedium).toBe("paid_social");
    expect(touch!.utmCampaign).toBe("launch");
    expect(touch!.utmContent).toBe("hook_a");
    expect(touch!.utmTerm).toBe("peptide");
    expect(touch![platform.touchField]).toBe(platform.clickIdValue);
  });

  it("writes a record with both touches set, from the portal alone", async () => {
    const { location } = await adClick(landingUrl(PLATFORMS[1]));
    const touch = captureAtPortal(location, PLATFORMS[1].referrer);

    const record = mergeAttribution(null, touch, {
      now: NOW,
      visitorId: "visitor-bounce",
      sessionId: "session-bounce",
    });

    expect(hasCampaignEvidence(record.first)).toBe(true);
    expect(hasCampaignEvidence(record.last)).toBe(true);
    expect(record.first!.ttclid).toBe(PLATFORMS[1].clickIdValue);
  });

  it("records the portal as the landing path, because that is where they landed", async () => {
    const { location } = await adClick(landingUrl(PLATFORMS[1]));
    const touch = captureAtPortal(location, PLATFORMS[1].referrer);

    // NOT /products/recon-water. The visitor genuinely never reached it, and this
    // file's governing rule is that absence of evidence is stored as absence —
    // a landing path they never saw would be an invention. Which page the ad
    // pointed at stays recoverable from `next`, which page_url keeps verbatim,
    // and utm_content identifies the creative either way.
    expect(touch!.landingPath).toBe("/account/login");
  });

  it("still refuses to invent a campaign for an untagged visit", async () => {
    // The guard rail on the whole change: carrying parameters must not make a
    // visit look paid when it never carried anything. An organic arrival at a
    // protected page redirects with only `next` on it.
    const { location } = await adClick("/products/recon-water");
    expect(location.searchParams.get("next")).toBe("/products/recon-water");
    expect([...location.searchParams.keys()]).toEqual(["next"]);
    expect(captureAtPortal(location, "https://www.google.com/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CASE 2 — THE VISITOR SIGNS IN AND CONVERTS.
//
// The portal captures the touch, `next` restores the destination, the tracker
// fires again on that page, and the merged record is what becomes the order's
// attribution row. First touch must survive the whole trip.
// ---------------------------------------------------------------------------
describe("a visitor who signs in and converts", () => {
  /** The three captures a real funnel produces, folded in order. */
  async function funnel(platform: (typeof PLATFORMS)[number]) {
    const { location } = await adClick(landingUrl(platform));

    // 1. The portal, signed out.
    let record: AttributionRecord = mergeAttribution(null, captureAtPortal(location, platform.referrer), {
      now: NOW,
      visitorId: "visitor-converts",
      sessionId: "session-converts",
    });

    // 2. The destination `next` restores after sign-in. The auth form pushes
    //    the visitor here, so the tracker sees the tagged URL a second time —
    //    this is the capture that used to be the FIRST one.
    const restored = new URL(location.searchParams.get("next") ?? "", ORIGIN);
    record = mergeAttribution(
      record,
      parseAttributionTouch({
        search: restored.search,
        pathname: restored.pathname,
        referrer: null,
        now: new Date(NOW.getTime() + 30_000),
      }),
      { now: NOW, visitorId: "visitor-converts", sessionId: "session-converts" },
    );

    // 3. An untagged page view on the way to checkout must not erase anything.
    record = mergeAttribution(
      record,
      parseAttributionTouch({ search: "", pathname: "/cart", referrer: null, now: new Date(NOW.getTime() + 60_000) }),
      { now: NOW, visitorId: "visitor-converts", sessionId: "session-converts" },
    );

    return { record, restored };
  }

  it.each(PLATFORMS)("restores the $name ad's original destination", async (platform) => {
    const { restored } = await funnel(platform);
    expect(restored.pathname).toBe("/products/recon-water");
    expect(restored.searchParams.get("utm_campaign")).toBe("launch");
    expect(restored.searchParams.get(platform.clickIdKey)).toBe(platform.clickIdValue);
  });

  it.each(PLATFORMS)("carries the $name click id all the way onto the order row", async (platform) => {
    const { record } = await funnel(platform);

    const row = toOrderAttributionRow("ORDER-1", record) as Record<string, unknown>;

    expect(row[platform.orderColumn]).toBe(platform.clickIdValue);
    expect(row.first_utm_source).toBe(platform.utmSource);
    expect(row.first_utm_campaign).toBe("launch");
    expect(row.first_utm_content).toBe("hook_a");
    expect(row.last_utm_source).toBe(platform.utmSource);
    expect(row.visitor_id).toBe("visitor-converts");
  });

  it("keeps first touch pinned to the portal arrival, not the post-login page", async () => {
    const { record } = await funnel(PLATFORMS[1]);
    // First touch is the moment the ad delivered them. Signing in is not a new
    // campaign, so it must not overwrite it.
    expect(record.first!.landingPath).toBe("/account/login");
    expect(record.last!.landingPath).toBe("/products/recon-water");
    expect(record.first!.ttclid).toBe(PLATFORMS[1].clickIdValue);
    expect(record.last!.ttclid).toBe(PLATFORMS[1].clickIdValue);
  });

  it("gives the bouncer and the converter the same first-touch attribution", async () => {
    // The requirement stated plainly: signing in must not change WHO gets
    // credited, only how much more is known afterwards.
    const { location } = await adClick(landingUrl(PLATFORMS[0]));
    const bounced = mergeAttribution(null, captureAtPortal(location, PLATFORMS[0].referrer), { now: NOW });
    const { record: converted } = await funnel(PLATFORMS[0]);

    expect(converted.first!.utmSource).toBe(bounced.first!.utmSource);
    expect(converted.first!.utmCampaign).toBe(bounced.first!.utmCampaign);
    expect(converted.first!.utmContent).toBe(bounced.first!.utmContent);
    expect(converted.first!.fbclid).toBe(bounced.first!.fbclid);
  });
});

// ---------------------------------------------------------------------------
// The properties that stop this from becoming a new hole of its own.
// ---------------------------------------------------------------------------
describe("carrying ad parameters is safe and stable", () => {
  it("does not let a crafted parameter move the destination", async () => {
    const { location } = await adClick(
      "/products/recon-water?utm_source=tiktok&next=https://evil.example/steal&redirect=//evil.example",
    );

    // The pathname is assigned by middleware, never read from the request, and
    // `next` is rebuilt from the request's own path — so the attacker's own
    // `next` is demoted to a nested query parameter of the real one.
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/account/login");

    // The property that matters is not "the string evil.example is absent" —
    // it survives, inertly, as part of the path's own query, and asserting its
    // absence would pin a coincidence instead of the guarantee. What must hold
    // is that resolving `next` the way the sign-in form does lands back on this
    // origin. safeInternalPath is the same function the form uses.
    const next = location.searchParams.get("next")!;
    expect(safeInternalPath(next, "/")).toBe(next);
    expect(new URL(next, ORIGIN).origin).toBe(ORIGIN);
    expect(new URL(next, ORIGIN).pathname).toBe("/products/recon-water");
  });

  it.each([
    ["protocol-relative", "//evil.example/steal"],
    ["backslash-smuggled", "/\\evil.example/steal"],
    ["absolute", "https://evil.example/steal"],
    ["control character", "/products /x"],
  ])("rejects a %s next value at the form", (_label, hostile) => {
    // The wall never emits one of these — it builds `next` from the request's
    // own pathname — but the parameter rides in a URL anyone can hand-build, so
    // the form re-validates rather than trusting the hop it arrived on.
    expect(safeInternalPath(hostile, "/account")).toBe("/account");
  });

  it("refuses to forward parameters it does not know", async () => {
    const { location } = await adClick("/products/recon-water?utm_source=tiktok&session_token=secret&admin=1");
    expect(location.searchParams.get("utm_source")).toBe("tiktok");
    // Only the known ad keys move up. Anything else stays inside `next`, where
    // it is inert, rather than being republished onto a new URL.
    expect(location.searchParams.has("session_token")).toBe(false);
    expect(location.searchParams.has("admin")).toBe(false);
  });

  it("strips control characters out of a crafted value", async () => {
    const { response, location } = await adClick(
      `/products/recon-water?utm_campaign=${encodeURIComponent("launch\r\nX-Injected: 1")}`,
    );
    // Nothing that could split a header survives into one. Lowercased because
    // a campaign tag goes through normalizeCampaignTag, same as the parser.
    expect(location.searchParams.get("utm_campaign")).toBe("launch x-injected: 1");
    expect(response.headers.get("location")).not.toContain("\n");
  });

  it("lowercases a campaign tag so both sides of the ROAS join agree", async () => {
    // ads/utm.ts lowercases on the SPEND side; normalizeCampaignTag does it on
    // the revenue side. A tag carried across the wall has to leave here in the
    // same case it would have been stored in, or `Hook_A` reaches
    // website_analytics_events — which posts params.get() raw, without the
    // parser — while the order row holds `hook_a`, and the creative shows spend
    // against zero revenue.
    const { location } = await adClick(
      "/products/recon-water?utm_source=TikTok&utm_campaign=Summer_Launch&utm_content=Hook_A&ttclid=TT_Click_Id_KeepCase",
    );

    expect(location.searchParams.get("utm_source")).toBe("tiktok");
    expect(location.searchParams.get("utm_campaign")).toBe("summer_launch");
    expect(location.searchParams.get("utm_content")).toBe("hook_a");
    // A click id is an opaque token the platform matches on, NOT a join key we
    // own — lowercasing one would break the conversion API. Case is preserved.
    expect(location.searchParams.get("ttclid")).toBe("TT_Click_Id_KeepCase");

    const touch = captureAtPortal(location, null);
    expect(touch!.utmContent).toBe("hook_a");
    expect(touch!.ttclid).toBe("TT_Click_Id_KeepCase");
  });

  it.each(["{{campaign.name}}", "__CAMPAIGN_NAME__", "{{ad.id}}"])(
    "drops the unexpanded macro %s rather than carrying it",
    async (macro) => {
      // A platform that fails to substitute its own macro sends the literal
      // template. The parser already refuses it; carrying it would put a
      // template string on a URL and, from there, into a column as though it
      // were a campaign.
      const { location } = await adClick(
        `/products/recon-water?utm_campaign=${encodeURIComponent(macro)}&utm_source=tiktok`,
      );
      expect(location.searchParams.has("utm_campaign")).toBe(false);
      // The tags either side of it still travel — one bad value is not a reason
      // to lose the whole touch.
      expect(location.searchParams.get("utm_source")).toBe("tiktok");
      expect(captureAtPortal(location, null)!.utmCampaign).toBeNull();
    },
  );

  it("hands the portal exactly what a direct landing would have parsed", async () => {
    // The invariant the whole copy exists to hold: going through the wall must
    // produce the same touch as never having met it. Compared field by field
    // rather than by eye, so a future divergence between copyAdParams and the
    // parser fails here instead of silently splitting the join.
    const raw = "/products/recon-water?utm_source=TikTok&utm_medium=Paid_Social&utm_campaign=Launch"
      + "&utm_content=Hook_A&utm_term=Peptide&ttclid=TT_9&SCCID=Snap_9";

    const direct = parseAttributionTouch({
      search: new URL(raw, ORIGIN).search,
      pathname: "/products/recon-water",
      referrer: null,
      now: NOW,
    });
    const throughWall = captureAtPortal((await adClick(raw)).location, null);

    const fields = ["utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "ttclid", "scCid"] as const;
    for (const field of fields) {
      // Field name carried into the assertion so a failure names the field
      // that diverged rather than just showing two unequal strings.
      expect([field, throughWall![field]]).toEqual([field, direct![field]]);
    }
  });

  it("caps an absurdly long value rather than reflecting it whole", async () => {
    const { location } = await adClick(`/products/recon-water?utm_campaign=${"a".repeat(4000)}`);
    expect(location.searchParams.get("utm_campaign")!.length).toBe(512);
  });

  it("normalises Snapchat's casing to one spelling", async () => {
    // Snapchat sends ScCid, sccid and SCCID depending on the surface. Whatever
    // arrives, one spelling leaves — so the parser's any-case read and the
    // stored column agree.
    for (const spelling of ["ScCid", "sccid", "SCCID"]) {
      const { location } = await adClick(`/products/recon-water?utm_source=snapchat&${spelling}=snap-9`);
      expect(location.searchParams.get("ScCid")).toBe("snap-9");
      expect(captureAtPortal(location, null)!.scCid).toBe("snap-9");
    }
  });

  it("is idempotent across a refresh and a back/forward", async () => {
    // Every hop is computed from the original request, so replaying it produces
    // a byte-identical URL: no parameter accumulates, doubles or drifts.
    const first = await adClick(landingUrl(PLATFORMS[1]));
    const second = await adClick(landingUrl(PLATFORMS[1]));
    expect(second.location.href).toBe(first.location.href);
    expect([...second.location.searchParams.getAll("utm_campaign")]).toEqual(["launch"]);

    // And re-capturing the same portal URL cannot corrupt a stored record:
    // first touch stays put, last touch simply re-affirms the same campaign.
    const touch = captureAtPortal(first.location, null);
    let record = mergeAttribution(null, touch, { now: NOW });
    const firstAt = record.first!.at;
    record = mergeAttribution(record, captureAtPortal(second.location, null), { now: NOW });
    expect(record.first!.at).toBe(firstAt);
    expect(record.first!.utmCampaign).toBe("launch");
    expect(record.last!.utmCampaign).toBe("launch");
  });

  it("carries the query through the legacy /login hop as well", async () => {
    // /login is a bookmark-era redirect to the real portal that used to drop
    // its query string entirely — the same attribution loss as the wall's, one
    // route further out. The whole query is forwarded here (not just the ad
    // keys) because this hop is not the access boundary: it is a rename, and a
    // rename that edits the URL is a second thing to reason about.
    const page = (await import("@/app/login/page")).default;

    // redirect() signals by throwing, and carries the destination in `digest`
    // as "NEXT_REDIRECT;replace;<url>;<status>;". Asserting on that string is
    // asserting on the URL a browser would actually be sent.
    let digest = "redirect() did not run";
    try {
      await page({ searchParams: Promise.resolve({ utm_source: "tiktok", ttclid: "TT_LEGACY_1" }) });
    } catch (thrown) {
      digest = String((thrown as { digest?: string }).digest ?? "");
    }

    expect(digest).toContain("/account/login?");
    expect(digest).toContain("utm_source=tiktok");
    expect(digest).toContain("ttclid=TT_LEGACY_1");
  });

  it("stores the analytics tag under the same key the order side uses", async () => {
    // THE OTHER HALF OF THE JOIN. The browser tracker posts
    // params.get("utm_content") RAW to /api/analytics/track — it never goes
    // through parseAttributionTouch — so before this, a walled visit wrote
    // `hook_a` (normalised by the wall) for the portal page view and `Hook_A`
    // (raw, restored verbatim by `next`) for the page view after sign-in. Two
    // rows, one campaign, two group-by keys, in the same session.
    //
    // Asserted against normalizeCampaignTag directly because that IS the rule
    // the route now applies, and it is the same one the parser applies.
    const { normalizeCampaignTag } = await import("@/lib/attribution");

    expect(normalizeCampaignTag("Hook_A")).toBe("hook_a");
    expect(normalizeCampaignTag("  Summer_Launch  ")).toBe("summer_launch");
    // ads-spend-roas.sql lower()s the order side on read, so lowercase-on-write
    // is what makes the analytics side land on the same key.
    expect(normalizeCampaignTag("TikTok")).toBe(normalizeCampaignTag("tiktok"));
    // A macro the platform failed to substitute is not a campaign name.
    expect(normalizeCampaignTag("{{campaign.name}}")).toBeNull();
    expect(normalizeCampaignTag("__CREATIVE__")).toBeNull();
  });

  it("leaves an already-present value alone across a different spelling", async () => {
    // The skip guard asks the question the same way the value will be READ, and
    // these two cases are why. Both are only reachable through a crafted `next`
    // on /r/<code> — the wall always starts from an empty query — and neither
    // could fabricate attribution, but the first performed the exact overwrite
    // the guard exists to prevent.
    const { copyAdParams } = await import("@/lib/attribution");

    // CASING: a destination already carrying `sccid=` did not look like it had
    // `ScCid`, so the copy ran and BOTH spellings ended up on the URL — where
    // the parser's case-insensitive read then preferred the one just copied in.
    const casing = new URLSearchParams("sccid=destination");
    expect(copyAdParams(new URLSearchParams("SCCID=incoming"), casing)).toBe(0);
    expect(casing.toString()).toBe("sccid=destination");
    expect(captureAtPortal(new URL(`https://x.test/p?${casing}`), null)!.scCid).toBe("destination");
  });

  it("treats an empty parameter on the destination as absent", async () => {
    // EMPTINESS: `utm_source=` with no value is "present" to has() but is
    // nothing to the parser, so it silently suppressed a real incoming tag.
    const { copyAdParams } = await import("@/lib/attribution");

    const empty = new URLSearchParams("utm_source=");
    expect(copyAdParams(new URLSearchParams("utm_source=tiktok&ttclid=abc"), empty)).toBe(2);
    expect(empty.get("utm_source")).toBe("tiktok");
    expect(empty.get("ttclid")).toBe("abc");
  });

  it("resolves a repeated parameter the same way the parser does", async () => {
    // ?utm_source=a&utm_source=b — both sides take the first, so a duplicated
    // tag cannot make the copy and a direct landing disagree.
    const { copyAdParams } = await import("@/lib/attribution");

    const to = new URLSearchParams();
    copyAdParams(new URLSearchParams("utm_source=a&utm_source=b"), to);
    expect(to.get("utm_source")).toBe("a");
    expect(parseAttributionTouch({ search: "?utm_source=a&utm_source=b", pathname: "/p", referrer: null, now: NOW })!.utmSource).toBe("a");
  });

  it("leaves an already-present value alone", async () => {
    // Precedence rule, and the reason the copy is idempotent: a value already
    // on the destination was put there deliberately and outranks a carried one.
    const params = new URLSearchParams("utm_source=tiktok");
    const target = new URLSearchParams("utm_source=already-here");
    // Exercised through the public helper rather than the wall, because the
    // wall always starts from an empty query.
    const { copyAdParams } = await import("@/lib/attribution");
    expect(copyAdParams(params, target)).toBe(0);
    expect(target.get("utm_source")).toBe("already-here");
  });
});
