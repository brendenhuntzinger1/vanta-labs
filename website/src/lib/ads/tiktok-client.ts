/**
 * TikTok Ads API — the interface, plus a simulation adapter.
 *
 * There is no live implementation here, and that is the honest state of things:
 * no credentials exist, and TikTok's category eligibility for research
 * materials has not been confirmed in writing. A stub that pretends to call the
 * API would be worse than nothing, because the first real run would discover
 * the pretence with money on the line.
 *
 * So the shape is fixed now and the transport is swapped later. The simulator
 * records what WOULD have been sent, which makes the whole pipeline —
 * generation, guardrails, publishing, reporting, decisions — runnable and
 * testable end to end today, with zero spend and zero credentials.
 *
 * When credentials arrive, `LiveTikTokClient` implements the same interface and
 * nothing above it changes.
 */

import type { PlatformRefs } from "./types";

export type TikTokCredentials = {
  /** Long-lived access token. Server-side only; never in client code. */
  accessToken: string;
  advertiserId: string;
  appId: string;
};

export type CampaignSpec = {
  name: string;
  objective: "TRAFFIC" | "CONVERSIONS" | "VIDEO_VIEWS";
  dailyBudget: number;
};

export type AdGroupSpec = {
  campaignId: string;
  name: string;
  dailyBudget: number;
  landingUrl: string;
  /** Set once a pixel exists. Null means optimise for clicks, not purchases. */
  pixelId?: string | null;
  optimizationEvent?: "CLICK" | "COMPLETE_PAYMENT" | "ADD_TO_CART" | null;
};

export type AdSpec = {
  adGroupId: string;
  name: string;
  /** Our creative_id. Carried into the ad name so reporting can join back. */
  creativeId: string;
  videoAssetPath: string;
  caption: string;
  callToAction: string;
  landingUrl: string;
};

export type ReportRow = {
  statDate: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach?: number;
  videoViews?: number;
  views2s?: number;
  views6s?: number;
  viewsComplete?: number;
  conversions?: number;
};

export interface TikTokAdsClient {
  readonly mode: "simulation" | "live";
  createCampaign(spec: CampaignSpec): Promise<{ campaignId: string }>;
  createAdGroup(spec: AdGroupSpec): Promise<{ adGroupId: string }>;
  publishAd(spec: AdSpec): Promise<PlatformRefs>;
  setAdStatus(adId: string, status: "ENABLE" | "DISABLE"): Promise<void>;
  setCampaignStatus(campaignId: string, status: "ENABLE" | "DISABLE"): Promise<void>;
  setBudget(target: { campaignId?: string; adGroupId?: string }, dailyBudget: number): Promise<void>;
  fetchReport(range: { since: string; until: string }): Promise<ReportRow[]>;
}

export type SimulatedCall = {
  at: string;
  method: string;
  payload: unknown;
  /** What the live client would have hit. Useful for reviewing before going live. */
  endpoint: string;
};

/**
 * Records intent, changes nothing, spends nothing.
 *
 * Ids are deterministic (`sim-…`) rather than random so tests are stable and so
 * a simulated id can never be mistaken for a real TikTok id in a database row —
 * if one shows up in production data, the prefix says exactly what happened.
 */
export class SimulationTikTokClient implements TikTokAdsClient {
  readonly mode = "simulation" as const;
  private calls: SimulatedCall[] = [];
  private counter = 0;
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  private record(method: string, endpoint: string, payload: unknown): void {
    this.calls.push({ at: this.now(), method, endpoint, payload });
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `sim-${prefix}-${String(this.counter).padStart(4, "0")}`;
  }

  calledWith(): readonly SimulatedCall[] {
    return this.calls;
  }

  async createCampaign(spec: CampaignSpec): Promise<{ campaignId: string }> {
    const campaignId = this.nextId("cmp");
    this.record("createCampaign", "/open_api/v1.3/campaign/create/", { ...spec, campaignId });
    return { campaignId };
  }

  async createAdGroup(spec: AdGroupSpec): Promise<{ adGroupId: string }> {
    const adGroupId = this.nextId("adg");
    this.record("createAdGroup", "/open_api/v1.3/adgroup/create/", { ...spec, adGroupId });
    return { adGroupId };
  }

  async publishAd(spec: AdSpec): Promise<PlatformRefs> {
    const adId = this.nextId("ad");
    this.record("publishAd", "/open_api/v1.3/ad/create/", { ...spec, adId });
    const utmContent = new URL(spec.landingUrl).searchParams.get("utm_content");
    if (!utmContent) {
      // Publishing without the tracking token would produce an ad whose
      // performance can never be joined to a creative. Refuse rather than
      // create an orphan.
      throw new Error(`landing URL for ${spec.creativeId} carries no utm_content — refusing to publish an untrackable ad`);
    }
    return {
      platform: "tiktok",
      advertiserId: "sim-advertiser",
      campaignId: "sim-campaign",
      adGroupId: spec.adGroupId,
      adId,
      utmContent,
      publishedAt: this.now(),
    };
  }

  async setAdStatus(adId: string, status: "ENABLE" | "DISABLE"): Promise<void> {
    this.record("setAdStatus", "/open_api/v1.3/ad/status/update/", { adId, status });
  }

  async setCampaignStatus(campaignId: string, status: "ENABLE" | "DISABLE"): Promise<void> {
    this.record("setCampaignStatus", "/open_api/v1.3/campaign/status/update/", { campaignId, status });
  }

  async setBudget(target: { campaignId?: string; adGroupId?: string }, dailyBudget: number): Promise<void> {
    this.record("setBudget", "/open_api/v1.3/campaign/update/", { ...target, dailyBudget });
  }

  /**
   * Returns nothing. A simulator that invented plausible impressions would be
   * the single most dangerous thing in this codebase: fabricated performance
   * data flowing into a decision engine that recommends real spend. Tests that
   * need numbers construct them explicitly.
   */
  async fetchReport(range: { since: string; until: string }): Promise<ReportRow[]> {
    this.record("fetchReport", "/open_api/v1.3/report/integrated/get/", range);
    return [];
  }
}

/**
 * What must exist before a live client can be written. Checked at startup so
 * the failure is a clear message rather than a 401 from a vendor.
 */
export type ReadinessReport = {
  ready: boolean;
  /** Needed every time the system reads or changes anything on TikTok. */
  missing: string[];
  /**
   * Needed only to obtain the access token, once. Listing these alongside the
   * runtime credentials made the setup look twice as large as it is: the app id
   * and secret are used in a single authorisation exchange and never again, so
   * they belong in a different column from the two values the system actually
   * runs on.
   */
  oneTimeSetup: string[];
  blockedOn: string[];
};

export function assessTikTokReadiness(env: Record<string, string | undefined>): ReadinessReport {
  const missing: string[] = [];
  for (const key of ["TIKTOK_ADS_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"]) {
    if (!env[key]?.trim()) missing.push(key);
  }
  const oneTimeSetup: string[] = [];
  for (const key of ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"]) {
    if (!env[key]?.trim()) oneTimeSetup.push(key);
  }
  return {
    ready: false,
    missing,
    oneTimeSetup,
    // These are not environment variables and cannot be satisfied by config.
    // Listing them here keeps the honest blockers next to the technical ones.
    blockedOn: [
      "written TikTok category eligibility determination for research materials",
      "TikTok Business Center and advertiser account with business verification",
      "domain verification for the production domain",
      "owner approval to leave simulation mode",
    ],
  };
}
