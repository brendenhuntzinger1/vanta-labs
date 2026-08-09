import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdsWritesDisabledError,
  assertWritesEnabled,
  callAdsApi,
  fetchCampaignPerformance,
  readAdsCredentials,
  setCampaignStatus,
  toCampaignPerformance,
  writesEnabled,
  type Transport,
} from "./tiktok-ads-api";

const credentials = { accessToken: "ads-token-value-xyz", advertiserId: "7672065135046426641" };

const respond = (body: unknown, status = 200): Transport =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  delete process.env.TIKTOK_ADS_WRITE_ENABLED;
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("needs both a token and an advertiser id", () => {
    expect(readAdsCredentials({ TIKTOK_ADS_ACCESS_TOKEN: "t" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(readAdsCredentials({ TIKTOK_ADVERTISER_ID: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      readAdsCredentials({ TIKTOK_ADS_ACCESS_TOKEN: "t", TIKTOK_ADVERTISER_ID: "1" } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ accessToken: "t", advertiserId: "1" });
  });
});

describe("TikTok answers 200 to failures", () => {
  it("treats a non-zero code as a failure even on HTTP 200", async () => {
    // The trap this exists for: a status-only check reports zero spend on a
    // permissions error and calls it a quiet day.
    const result = await callAdsApi("/report/integrated/get/", {
      credentials,
      transport: respond({ code: 40105, message: "Access token is incorrect", request_id: "req-9" }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe(40105);
    expect(result.ok === false && result.message).toMatch(/Access token/);
    expect(result.ok === false && result.requestId).toBe("req-9");
  });

  it("succeeds only on code 0", async () => {
    const result = await callAdsApi<{ list: unknown[] }>("/x/", {
      credentials,
      transport: respond({ code: 0, data: { list: [] }, request_id: "req-1" }),
    });
    expect(result.ok).toBe(true);
  });

  it("does not throw on a network failure — the failure is a value", async () => {
    const transport: Transport = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await callAdsApi("/x/", { credentials, transport });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/ECONNRESET/);
  });

  it("survives a non-JSON response", async () => {
    const transport: Transport = vi.fn(async () => new Response("<html>gateway</html>", { status: 502 }));
    const result = await callAdsApi("/x/", { credentials, transport });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/not JSON/);
  });

  it("sends the token only in the Access-Token header", async () => {
    const transport = respond({ code: 0, data: {} });
    await callAdsApi("/x/", { credentials, method: "POST", body: { a: 1 }, transport });
    const [url, init] = (transport as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toContain("business-api.tiktok.com/open_api/v1.3/x/");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe(credentials.accessToken);
    expect(String(init.body)).not.toContain(credentials.accessToken);
  });
});

describe("metrics are derived, never guessed", () => {
  const row = {
    dimensions: { campaign_id: "cmp-1", stat_time_day: "2026-08-09 00:00:00" },
    metrics: { spend: "125.00", impressions: "50000", clicks: "600", conversion: "5", campaign_name: "Prospecting" },
  };

  it("computes CTR, CPC, CPM and CPA from the raw counts", () => {
    const performance = toCampaignPerformance(row);
    expect(performance.ctr).toBeCloseTo(0.012, 6);
    expect(performance.cpc).toBeCloseTo(125 / 600, 6);
    // CPM is per THOUSAND impressions — the denominator is impressions/1000.
    expect(performance.cpm).toBeCloseTo(2.5, 6);
    expect(performance.cpa).toBe(25);
    expect(performance.statDate).toBe("2026-08-09");
  });

  it("returns null rather than Infinity when a denominator is zero", () => {
    const empty = toCampaignPerformance({
      dimensions: { campaign_id: "c", stat_time_day: "2026-08-09" },
      metrics: { spend: 10, impressions: 0, clicks: 0, conversion: 0 },
    });
    expect(empty.ctr).toBeNull();
    expect(empty.cpc).toBeNull();
    expect(empty.cpm).toBeNull();
    expect(empty.cpa).toBeNull();
  });

  it("maps a report response into rows", async () => {
    const result = await fetchCampaignPerformance({
      credentials,
      since: "2026-08-01",
      until: "2026-08-09",
      transport: respond({ code: 0, data: { list: [row] }, request_id: "r" }),
    });
    expect(result.ok && result.data[0].campaignName).toBe("Prospecting");
  });

  it("passes a rejection straight through instead of returning an empty list", async () => {
    // Returning [] here would render as "no spend" — indistinguishable from a
    // real quiet period, and wrong.
    const result = await fetchCampaignPerformance({
      credentials,
      since: "2026-08-01",
      until: "2026-08-09",
      transport: respond({ code: 40001, message: "advertiser_id invalid" }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("credentials alone must not be able to spend money", () => {
  it("refuses a write when the switch is off", () => {
    expect(writesEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(() => assertWritesEnabled("pause a campaign", {} as unknown as NodeJS.ProcessEnv)).toThrow(AdsWritesDisabledError);
  });

  it("refuses even though a valid token is present", async () => {
    await expect(
      setCampaignStatus({ credentials, campaignId: "cmp-1", status: "ENABLE", transport: respond({ code: 0 }) }),
    ).rejects.toThrow(/TIKTOK_ADS_WRITE_ENABLED/);
  });

  it("gates pausing too, because whatever may pause may also un-pause", async () => {
    await expect(
      setCampaignStatus({ credentials, campaignId: "cmp-1", status: "DISABLE", transport: respond({ code: 0 }) }),
    ).rejects.toThrow(AdsWritesDisabledError);
  });

  it("allows the write only when the separate switch is explicitly true", async () => {
    process.env.TIKTOK_ADS_WRITE_ENABLED = "true";
    const result = await setCampaignStatus({
      credentials,
      campaignId: "cmp-1",
      status: "DISABLE",
      transport: respond({ code: 0, data: {} }),
    });
    expect(result.ok).toBe(true);
  });

  it("is not fooled by a truthy-looking value", () => {
    for (const value of ["1", "yes", "TRUE ", "on", ""]) {
      expect(writesEnabled({ TIKTOK_ADS_WRITE_ENABLED: value } as unknown as NodeJS.ProcessEnv)).toBe(
        value.trim().toLowerCase() === "true",
      );
    }
  });
});
