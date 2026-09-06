import { describe, expect, it } from "vitest";

import { fetchConnectorSpend, normalizeSpendRow } from "./windsor-client";
import { runSpendIngest } from "./spend-ingest";

// ---------------------------------------------------------------------------
// WINDSOR FAILS WITH A 200 AND A SENTENCE WHERE THE DATA GOES.
//
// Measured against the live Windsor account on 2026-09-06, every one of the
// four connectors answered HTTP 200 with this single row:
//
//   { "date": "2026-09-06",
//     "ad_id": "Uh-oh! You've connected more data sources than your Basic plan
//               allows. Upgrade here: https://onboard.windsor.ai/...",
//     "ad_name": <the same sentence>, "link_url": <the same sentence>,
//     "spend": 0, "clicks": 0, "impressions": 0 }
//
// Nothing in the pipeline objected. The id was non-empty, the date parsed, and
// zero is a legitimate spend — so a 128-character prefix of an error message
// was written into ad_spend_daily as an ad, on every connector, and the ingest
// reported `status: "ok"` with no alert. The account had been returning no real
// spend at all and the only symptom was a dashboard of zeroes, which is exactly
// what a genuinely quiet week looks like.
//
// Two rules close it, and the second is the one that reaches a human:
//   1. An ad id containing whitespace is not an ad id — it is the feed talking.
//   2. Rows that arrived and were ALL refused is a connector FAILURE, not an
//      empty success. An empty array stays a success, because a paused account
//      must not page anyone.
// ---------------------------------------------------------------------------

const NOTICE =
  "Uh-oh! You've connected more data sources than your Basic plan allows. " +
  "Upgrade here: https://onboard.windsor.ai/app/manage-subscription";

const noticeRow = {
  date: "2026-09-06",
  ad_id: NOTICE,
  ad_name: NOTICE,
  campaign: NOTICE,
  campaign_id: NOTICE,
  link_url: NOTICE,
  spend: 0,
  clicks: 0,
  impressions: 0,
  actions_purchase: 0,
};

const goodRow = {
  date: "2026-09-06",
  ad_id: "120210000000000001",
  ad_name: "Hook A",
  campaign: "Camp",
  campaign_id: "1234",
  adset_id: "5678",
  adset_name: "Set",
  link_url: "https://www.vantalabsresearch.com/?utm_source=facebook&utm_campaign=camp_a&utm_content=hook_a",
  spend: 12.34,
  clicks: 10,
  impressions: 1000,
  actions_purchase: 1,
};

const jsonResponse = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("Windsor's account notice is never mistaken for ad data", () => {
  it("refuses a row whose ad_id is a sentence", () => {
    const outcome = normalizeSpendRow("facebook", noticeRow);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/ad_id is not an identifier/);
  });

  it("still accepts every real platform ad id shape", () => {
    for (const adId of [
      "120210000000000001", // Meta
      "1798765432109876543", // TikTok
      "fcdb2b39-62e3-4942-8017-a05c99e7ae95", // Snapchat
      "a2_jld9zr1pbt48", // Reddit
      "t2_ABC-123_x", // Reddit, with the punctuation their ids carry
    ]) {
      const outcome = normalizeSpendRow("facebook", { ...goodRow, ad_id: adId });
      expect(outcome.ok, `ad id ${adId} must be accepted`).toBe(true);
      if (outcome.ok) expect(outcome.row.adId).toBe(adId);
    }
  });

  it("reports a connector whose every row was refused as FAILED, not empty", async () => {
    const outcome = await fetchConnectorSpend({
      connector: "facebook",
      apiKey: "k",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
      fetchImpl: jsonResponse({ data: [noticeRow] }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/none usable/);
      // Windsor's own words reach the operator, because the fix differs per cause.
      expect(outcome.error).toMatch(/Basic plan/);
    }
  });

  it("a genuinely empty window is still a SUCCESS with zero rows", async () => {
    const outcome = await fetchConnectorSpend({
      connector: "facebook",
      apiKey: "k",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
      fetchImpl: jsonResponse({ data: [] }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rows).toHaveLength(0);
  });

  it("keeps the good rows when only SOME are refused", async () => {
    const outcome = await fetchConnectorSpend({
      connector: "facebook",
      apiKey: "k",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
      fetchImpl: jsonResponse({ data: [noticeRow, goodRow] }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.rows).toHaveLength(1);
      expect(outcome.rows[0].adId).toBe("120210000000000001");
      expect(outcome.rejections).toHaveLength(1);
    }
  });

  it("the notice on EVERY connector throws, so the sweep alerts a human", async () => {
    const written: Record<string, unknown>[] = [];
    await expect(
      runSpendIngest({
        apiKey: "k",
        now: new Date("2026-09-06T09:00:00Z"),
        lastIngestedAt: null,
        fetchImpl: jsonResponse({ data: [noticeRow] }),
        upsert: async (rows) => {
          written.push(...rows);
          return { error: null };
        },
      }),
    ).rejects.toThrow(/failed on every connector/);
    // And nothing reached the table.
    expect(written).toHaveLength(0);
  });

  it("one connector's notice does not discard the other three", async () => {
    const fetchImpl = (async (url: string) =>
      new Response(
        JSON.stringify({ data: String(url).includes("/snapchat") ? [noticeRow] : [goodRow] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await runSpendIngest({
      apiKey: "k",
      now: new Date("2026-09-06T09:00:00Z"),
      lastIngestedAt: null,
      fetchImpl,
      upsert: async () => ({ error: null }),
    });

    expect(result.ran).toBe(true);
    const byConnector = Object.fromEntries(result.connectors.map((c) => [c.connector, c.status]));
    expect(byConnector.snapchat).toBe("failed");
    expect(byConnector.facebook).toBe("ok");
    expect(byConnector.tiktok).toBe("ok");
    expect(byConnector.reddit).toBe("ok");
  });
});
