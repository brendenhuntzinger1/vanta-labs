import { describe, expect, it, vi } from "vitest";
import {
  RESTATEMENT_WINDOW_DAYS,
  runSpendIngest,
  spendWindow,
  toDbRow,
} from "./spend-ingest";
import {
  fetchConnectorSpend,
  fieldsFor,
  normalizeSpendRow,
  toNumber,
  toStatDate,
} from "./windsor-client";
import { adPlatformKey, buildAdLandingUrl, isSafeTag, parseAdTagsFromUrl, toSafeTag } from "./utm";

// -----------------------------------------------------------------------------
// The join key
// -----------------------------------------------------------------------------

describe("platform naming — one spelling", () => {
  it("collapses every spelling of Meta onto one key", () => {
    for (const raw of ["meta", "Meta", " FACEBOOK ", "fb", "instagram", "ig"]) {
      expect(adPlatformKey(raw)).toBe("facebook");
    }
  });

  it("collapses Snapchat and TikTok variants", () => {
    expect(adPlatformKey("snap")).toBe("snapchat");
    expect(adPlatformKey("Snapchat")).toBe("snapchat");
    expect(adPlatformKey("tt")).toBe("tiktok");
  });

  it("returns null for absent input, so 'unknown' never becomes a platform", () => {
    expect(adPlatformKey(null)).toBeNull();
    expect(adPlatformKey("  ")).toBeNull();
  });

  it("passes an unrecognised source through rather than discarding it", () => {
    // An unknown platform is a fact worth seeing in the output.
    expect(adPlatformKey("pinterest")).toBe("pinterest");
  });

  // The same mapping lives in ads-spend-roas.sql as ad_platform_key(). If these
  // two ever disagree, spend and revenue join to different platform keys and
  // every campaign reads as unattributed — the single most likely silent failure
  // in this system, so it is pinned here explicitly.
  it("matches the SQL function's mapping key for key", () => {
    const sqlMapping: Record<string, string> = {
      fb: "facebook",
      meta: "facebook",
      facebook: "facebook",
      instagram: "facebook",
      ig: "facebook",
      tiktok: "tiktok",
      tt: "tiktok",
      reddit: "reddit",
      snap: "snapchat",
      snapchat: "snapchat",
    };
    for (const [input, expected] of Object.entries(sqlMapping)) {
      expect(adPlatformKey(input), `ad_platform_key(${input})`).toBe(expected);
    }
  });
});

describe("tag safety", () => {
  it("accepts only what survives four platforms' URL handling", () => {
    expect(isSafeTag("hook_a_ugc")).toBe(true);
    expect(isSafeTag("hook-a-2")).toBe(true);
    expect(isSafeTag("Hook A")).toBe(false);
    expect(isSafeTag("hook.a")).toBe(false);
    expect(isSafeTag("")).toBe(false);
    expect(isSafeTag("x".repeat(65))).toBe(false);
  });

  it("slugifies a human label", () => {
    expect(toSafeTag("Hook A — UGC (v2)")).toBe("hook_a_ugc_v2");
    expect(toSafeTag("  Launch Q3  ")).toBe("launch_q3");
  });

  it("returns null rather than a mangled guess when nothing usable survives", () => {
    expect(toSafeTag("!!!")).toBeNull();
    expect(toSafeTag("")).toBeNull();
  });
});

describe("landing URL builder — refuses rather than repairs", () => {
  const base = { baseUrl: "https://vantalabsresearch.com", path: "/products/bpc-157" };

  it("builds the tagged URL", () => {
    const result = buildAdLandingUrl({
      ...base,
      tags: { platform: "meta", campaign: "launch_q3", content: "hook_a_ugc", term: "broad_18_34" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.pathname).toBe("/products/bpc-157");
    // Normalised, so it joins to the spend feed's `facebook`.
    expect(url.searchParams.get("utm_source")).toBe("facebook");
    expect(url.searchParams.get("utm_medium")).toBe("paid_social");
    expect(url.searchParams.get("utm_campaign")).toBe("launch_q3");
    expect(url.searchParams.get("utm_content")).toBe("hook_a_ugc");
    expect(url.searchParams.get("utm_term")).toBe("broad_18_34");
  });

  it("omits utm_term when there isn't one", () => {
    const result = buildAdLandingUrl({ ...base, tags: { platform: "tiktok", campaign: "c", content: "d" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.url).searchParams.has("utm_term")).toBe(false);
  });

  it("reports every problem at once rather than the first", () => {
    const result = buildAdLandingUrl({
      ...base,
      tags: { platform: "", campaign: "Launch Q3", content: "Hook A" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(3);
    expect(result.problems.join(" ")).toContain("platform is required");
    expect(result.problems.join(" ")).toContain("utm_campaign");
    expect(result.problems.join(" ")).toContain("utm_content");
  });

  it("refuses a path that is not a path", () => {
    const result = buildAdLandingUrl({
      ...base,
      path: "products/bpc-157",
      tags: { platform: "reddit", campaign: "c", content: "d" },
    });
    expect(result.ok).toBe(false);
  });

  // A URL built here must parse back to the same tag, or spend and revenue land
  // on different rows.
  it("round-trips through the parser", () => {
    const built = buildAdLandingUrl({
      ...base,
      tags: { platform: "snap", campaign: "launch_q3", content: "hook_b" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = parseAdTagsFromUrl(built.url);
    expect(parsed.utmSource).toBe("snapchat");
    expect(parsed.utmCampaign).toBe("launch_q3");
    expect(parsed.utmContent).toBe("hook_b");
  });
});

describe("reading tags back off an ad the platform reported", () => {
  it("pulls the creative tag out of a full URL", () => {
    const parsed = parseAdTagsFromUrl(
      "https://vantalabsresearch.com/products/x?utm_source=tiktok&utm_campaign=launch_q3&utm_content=hook_a",
    );
    expect(parsed.utmContent).toBe("hook_a");
    expect(parsed.utmSource).toBe("tiktok");
  });

  it("survives a destination that is only a query string", () => {
    expect(parseAdTagsFromUrl("/products/x?utm_content=hook_c").utmContent).toBe("hook_c");
  });

  it("treats an unexpanded platform macro as absent, not as a tag", () => {
    // Reaches reporting whenever an ad is built with a macro the platform only
    // substitutes at click time. Storing it would create a creative called
    // "{{ad.name}}" that every such ad joins to.
    expect(parseAdTagsFromUrl("https://x.test/?utm_content={{ad.name}}").utmContent).toBeNull();
    expect(parseAdTagsFromUrl("https://x.test/?utm_content=__CLICKID__").utmContent).toBeNull();
  });

  it("treats a corrupted tag as absent rather than accepting it", () => {
    // A tag that arrives different from how it left joins to the wrong creative,
    // which is worse than joining to nothing.
    expect(parseAdTagsFromUrl("https://x.test/?utm_content=hook%20a!").utmContent).toBeNull();
  });

  it("returns nulls for no URL at all, which is Reddit and Snapchat every time", () => {
    expect(parseAdTagsFromUrl(null).utmContent).toBeNull();
    expect(parseAdTagsFromUrl("").utmContent).toBeNull();
    expect(parseAdTagsFromUrl("not a url").utmContent).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The spend feed
// -----------------------------------------------------------------------------

describe("field maps match what each connector actually exposes", () => {
  it("asks Meta for link_url and TikTok for landing_page_url", () => {
    expect(fieldsFor("facebook")).toContain("link_url");
    expect(fieldsFor("facebook")).toContain("adset_id");
    expect(fieldsFor("tiktok")).toContain("landing_page_url");
    expect(fieldsFor("tiktok")).toContain("adgroup_id");
  });

  it("asks Reddit and Snapchat for no URL, because they expose none", () => {
    expect(fieldsFor("reddit").some((f) => f.includes("url"))).toBe(false);
    expect(fieldsFor("snapchat").some((f) => f.includes("url"))).toBe(false);
    expect(fieldsFor("snapchat")).toContain("adsquad_id");
  });

  it("always asks for the common eight", () => {
    for (const c of ["facebook", "tiktok", "reddit", "snapchat"] as const) {
      for (const f of ["date", "campaign", "campaign_id", "ad_id", "ad_name", "spend", "clicks", "impressions"]) {
        expect(fieldsFor(c), `${c} missing ${f}`).toContain(f);
      }
    }
  });
});

describe("numbers — unreadable is null, never zero", () => {
  it("reads the shapes a platform actually sends", () => {
    expect(toNumber(12.5)).toBe(12.5);
    expect(toNumber("12.50")).toBe(12.5);
    expect(toNumber("1,234.56")).toBe(1234.56);
    expect(toNumber("0.00")).toBe(0);
  });

  it("refuses rather than coercing to zero", () => {
    // "we could not parse the spend" and "this ad spent nothing" must never be
    // the same value: the first reads as a cheap campaign worth scaling.
    expect(toNumber("n/a")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });
});

describe("dates", () => {
  it("reads the formats a connector sends", () => {
    expect(toStatDate("2026-09-06")).toBe("2026-09-06");
    expect(toStatDate("2026-09-06T00:00:00Z")).toBe("2026-09-06");
    expect(toStatDate("2026/09/06")).toBe("2026-09-06");
  });

  it("refuses anything else", () => {
    expect(toStatDate("06-09-2026")).toBeNull();
    expect(toStatDate("yesterday")).toBeNull();
    expect(toStatDate(null)).toBeNull();
  });
});

describe("row normalization", () => {
  const good = {
    date: "2026-09-05",
    campaign: "Launch Q3",
    campaign_id: "c1",
    ad_id: "a1",
    ad_name: "Hook A UGC",
    adset_id: "s1",
    adset_name: "Broad 18-34",
    link_url: "https://vantalabsresearch.com/products/x?utm_content=hook_a",
    spend: "12.34",
    clicks: "40",
    impressions: "1000",
  };

  it("normalises a Meta row and lifts the creative tag out of the URL", () => {
    const out = normalizeSpendRow("facebook", good);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row).toMatchObject({
      platform: "facebook",
      adId: "a1",
      statDate: "2026-09-05",
      campaignName: "Launch Q3",
      adgroupId: "s1",
      adgroupName: "Broad 18-34",
      utmContent: "hook_a",
      spend: 12.34,
      clicks: 40,
      impressions: 1000,
      currency: "USD",
    });
  });

  it("rejects a row with no ad id, because it has no primary key", () => {
    const out = normalizeSpendRow("facebook", { ...good, ad_id: null });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("ad_id");
  });

  it("rejects an unreadable date and an unreadable spend", () => {
    expect(normalizeSpendRow("facebook", { ...good, date: "nope" }).ok).toBe(false);
    expect(normalizeSpendRow("facebook", { ...good, spend: "n/a" }).ok).toBe(false);
  });

  it("rejects negative spend", () => {
    expect(normalizeSpendRow("facebook", { ...good, spend: "-5" }).ok).toBe(false);
  });

  it("treats missing impressions and clicks as zero, since a day with no delivery is real", () => {
    const out = normalizeSpendRow("facebook", { ...good, clicks: null, impressions: undefined });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.clicks).toBe(0);
    expect(out.row.impressions).toBe(0);
  });

  it("leaves utm_content null on a connector with no URL field", () => {
    const out = normalizeSpendRow("reddit", {
      date: "2026-09-05",
      ad_id: "r1",
      spend: "5.00",
      // Even if a URL were present under Meta's field name, Reddit's map has no
      // destinationUrl, so it must not be read.
      link_url: "https://x.test/?utm_content=hook_z",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.landingUrl).toBeNull();
    expect(out.row.utmContent).toBeNull();
    expect(out.row.platform).toBe("reddit");
  });
});

// -----------------------------------------------------------------------------
// Fetch and persist
// -----------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchConnectorSpend", () => {
  it("asks Windsor for the right connector, window and fields", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      seen.push(input);
      return jsonResponse({ data: [] });
    });
    await fetchConnectorSpend({
      connector: "tiktok",
      apiKey: "k",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-07",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = new URL(seen[0]);
    expect(url.pathname).toBe("/tiktok");
    expect(url.searchParams.get("api_key")).toBe("k");
    expect(url.searchParams.get("date_from")).toBe("2026-09-01");
    expect(url.searchParams.get("date_to")).toBe("2026-09-07");
    expect(url.searchParams.get("fields")).toContain("landing_page_url");
  });

  it("accepts both a bare array and a {data:[...]} envelope", async () => {
    const row = { date: "2026-09-05", ad_id: "a1", spend: "1.00" };
    const bare = await fetchConnectorSpend({
      connector: "reddit",
      apiKey: "k",
      dateFrom: "2026-09-05",
      dateTo: "2026-09-05",
      fetchImpl: (async () => jsonResponse([row])) as unknown as typeof fetch,
    });
    expect(bare.ok && bare.rows).toHaveLength(1);

    const wrapped = await fetchConnectorSpend({
      connector: "reddit",
      apiKey: "k",
      dateFrom: "2026-09-05",
      dateTo: "2026-09-05",
      fetchImpl: (async () => jsonResponse({ data: [row] })) as unknown as typeof fetch,
    });
    expect(wrapped.ok && wrapped.rows).toHaveLength(1);
  });

  it("passes Windsor's own explanation through on an HTTP error", async () => {
    const out = await fetchConnectorSpend({
      connector: "snapchat",
      apiKey: "k",
      dateFrom: "2026-09-05",
      dateTo: "2026-09-05",
      fetchImpl: (async () =>
        new Response("connector grant expired", { status: 403 })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The fix differs per cause, and an operator reads this at 2am.
    expect(out.error).toContain("403");
    expect(out.error).toContain("connector grant expired");
  });

  it("reports a network failure rather than throwing", async () => {
    const out = await fetchConnectorSpend({
      connector: "facebook",
      apiKey: "k",
      dateFrom: "2026-09-05",
      dateTo: "2026-09-05",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("ECONNRESET");
  });

  it("separates rejected rows from accepted ones instead of dropping them", async () => {
    const out = await fetchConnectorSpend({
      connector: "reddit",
      apiKey: "k",
      dateFrom: "2026-09-05",
      dateTo: "2026-09-05",
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            { date: "2026-09-05", ad_id: "a1", spend: "1.00" },
            { date: "2026-09-05", ad_id: null, spend: "9.00" },
          ],
        })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows).toHaveLength(1);
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0].reason).toContain("ad_id");
  });
});

describe("the trailing window", () => {
  it("covers seven UTC days ending today", () => {
    const { dateFrom, dateTo } = spendWindow(new Date("2026-09-06T13:45:00Z"));
    expect(dateTo).toBe("2026-09-06");
    expect(dateFrom).toBe("2026-08-31");
  });

  it("uses UTC, so a late-evening run does not shift the day", () => {
    // A local-time window would report 2026-09-07 here for a US deployment and
    // silently misalign every row against `stat_date`.
    expect(spendWindow(new Date("2026-09-06T23:59:00Z")).dateTo).toBe("2026-09-06");
    expect(spendWindow(new Date("2026-09-06T00:00:01Z")).dateTo).toBe("2026-09-06");
  });

  it("re-fetches a window rather than a single day", () => {
    expect(RESTATEMENT_WINDOW_DAYS).toBeGreaterThan(1);
  });
});

describe("toDbRow", () => {
  it("maps onto ad_spend_daily's columns", () => {
    const row = toDbRow({
      platform: "tiktok",
      adId: "a1",
      statDate: "2026-09-05",
      campaignId: "c1",
      campaignName: "Launch",
      adgroupId: "g1",
      adgroupName: "Broad",
      adName: "Hook A",
      landingUrl: "https://x.test/?utm_content=hook_a",
      utmContent: "hook_a",
      spend: 1.5,
      impressions: 10,
      clicks: 2,
      currency: "USD",
    });
    expect(row).toMatchObject({
      platform: "tiktok",
      ad_id: "a1",
      stat_date: "2026-09-05",
      campaign_id: "c1",
      campaign_name: "Launch",
      adgroup_id: "g1",
      adgroup_name: "Broad",
      ad_name: "Hook A",
      utm_content: "hook_a",
      spend: 1.5,
      impressions: 10,
      clicks: 2,
      currency: "USD",
      source: "windsor",
    });
  });
});

describe("runSpendIngest", () => {
  const ok = () => Promise.resolve({ error: null });

  it("names the unconfigured state instead of failing silently", async () => {
    const result = await runSpendIngest({ apiKey: "  ", now: new Date(), upsert: ok });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("WINDSOR_API_KEY");
    expect(result.connectors).toEqual([]);
  });

  it("writes every connector's rows and totals them", async () => {
    const upsert = vi.fn(ok);
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T00:00:00Z"),
      upsert,
      connectors: ["facebook", "reddit"],
      fetchImpl: (async (input: string) =>
        jsonResponse({
          data: [
            {
              date: "2026-09-05",
              ad_id: new URL(input).pathname.includes("reddit") ? "r1" : "f1",
              spend: "10.00",
              clicks: "5",
              impressions: "100",
            },
          ],
        })) as unknown as typeof fetch,
    });

    expect(result.ran).toBe(true);
    expect(result.dateFrom).toBe("2026-08-31");
    expect(result.dateTo).toBe("2026-09-06");
    expect(result.totalWritten).toBe(2);
    expect(result.totalSpend).toBe(20);
    expect(result.connectors.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing connector so the others still land", async () => {
    // Snapchat's grant expiring must not cost the store its Meta numbers.
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T00:00:00Z"),
      upsert: ok,
      connectors: ["facebook", "snapchat"],
      fetchImpl: (async (input: string) =>
        new URL(input).pathname.includes("snapchat")
          ? new Response("grant expired", { status: 403 })
          : jsonResponse({ data: [{ date: "2026-09-05", ad_id: "f1", spend: "7.00" }] })) as unknown as typeof fetch,
    });

    const byName = Object.fromEntries(result.connectors.map((c) => [c.connector, c]));
    expect(byName.facebook.status).toBe("ok");
    expect(byName.facebook.written).toBe(1);
    expect(byName.snapchat.status).toBe("failed");
    expect(byName.snapchat.error).toContain("403");
    expect(result.totalWritten).toBe(1);
  });

  it("reports an unapplied migration in the words that fix it", async () => {
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T00:00:00Z"),
      upsert: async () => ({ error: { code: "42P01", message: 'relation "ad_spend_daily" does not exist' } }),
      connectors: ["facebook"],
      fetchImpl: (async () =>
        jsonResponse({ data: [{ date: "2026-09-05", ad_id: "f1", spend: "1.00" }] })) as unknown as typeof fetch,
    });
    expect(result.connectors[0].status).toBe("failed");
    expect(result.connectors[0].error).toContain("ads-spend-roas.sql");
  });

  it("skips a fetch when the stored data is still fresh", async () => {
    // The sweep runs every 30 minutes; the platforms restate a few times a day.
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T12:00:00Z"),
      lastIngestedAt: new Date("2026-09-06T09:00:00Z"),
      upsert: ok,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("minimum interval");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches once the data is stale enough", async () => {
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T12:00:00Z"),
      lastIngestedAt: new Date("2026-09-06T05:00:00Z"),
      upsert: ok,
      connectors: ["facebook"],
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(result.ran).toBe(true);
  });

  it("fetches on the first ever run, with nothing stored", async () => {
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T12:00:00Z"),
      lastIngestedAt: null,
      upsert: ok,
      connectors: ["facebook"],
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(result.ran).toBe(true);
  });

  it("honours force, so an operator pressing refresh is not rate limited", async () => {
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T12:00:00Z"),
      lastIngestedAt: new Date("2026-09-06T11:59:00Z"),
      force: true,
      upsert: ok,
      connectors: ["facebook"],
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(result.ran).toBe(true);
  });

  it("counts spend it can see but cannot attribute", async () => {
    // Reddit exposes no landing URL, so this spend is real and untaggable. The
    // dashboard has to be able to show the size of its own blind spot.
    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T00:00:00Z"),
      upsert: ok,
      connectors: ["reddit"],
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            { date: "2026-09-05", ad_id: "r1", spend: "10.00" },
            { date: "2026-09-05", ad_id: "r2", spend: "0.00" },
          ],
        })) as unknown as typeof fetch,
    });
    // Only the row that actually spent counts as a blind spot.
    expect(result.connectors[0].untagged).toBe(1);
  });
});
