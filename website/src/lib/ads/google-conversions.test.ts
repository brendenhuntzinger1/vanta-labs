import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

function setAll(value: string | undefined) {
  for (const key of ENV_KEYS) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("googleCredentialStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll(undefined);
  });
  afterEach(() => setAll(undefined));

  it("is not configured with no credentials at all", async () => {
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(false);
  });

  it("is configured when every credential is present", async () => {
    setAll("value");
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(true);
  });

  it("FAILS CLOSED on partial configuration and names what is missing", async () => {
    setAll("value");
    delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const { googleCredentialStatus } = await import("./google-conversions");
    const status = googleCredentialStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("GOOGLE_ADS_REFRESH_TOKEN");
  });

  it("treats an empty string as absent, not as a credential", async () => {
    setAll("value");
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "   ";
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(false);
  });
});

describe("sendGoogleConversion", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll(undefined);
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    setAll(undefined);
    vi.unstubAllGlobals();
  });

  it("sends nothing when unconfigured, and says so rather than throwing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date("2026-08-27T12:00:00Z"),
    });
    expect(result.attempted).toBe(false);
    expect(result.delivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing on partial configuration", async () => {
    setAll("value");
    delete process.env.GOOGLE_ADS_CLIENT_SECRET;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("describeGoogleResult", () => {
  it("cannot leak a credential, because it has no field to carry one", async () => {
    const { describeGoogleResult } = await import("./google-conversions");
    const text = describeGoogleResult({
      attempted: true,
      delivered: false,
      code: 401,
      message: "UNAUTHENTICATED",
    });
    expect(text).toContain("401");
    expect(text).not.toContain("GOOGLE_ADS");
  });
});

describe("environment enforcement — mutation control", () => {
  it("refuses to send from a non-production environment even fully credentialed", async () => {
    vi.resetModules();
    setAll("value");
    process.env.VERCEL_ENV = "preview";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1", value: 10, currency: "USD" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(result.message).toMatch(/suppressed/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Deleting the serverAdsReportingAllowed() call makes this fail.
    delete process.env.VERCEL_ENV;
  });

  it("refuses when VERCEL_ENV is unset, because 'we could not tell' is not 'production'", async () => {
    vi.resetModules();
    setAll("value");
    delete process.env.VERCEL_ENV;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1", value: 10, currency: "USD" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
