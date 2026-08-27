import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID",
] as const;

/** Stubs a fully-allowed production environment so a send can proceed past the gate. */
function stubProductionEnvironment() {
  process.env.VERCEL_ENV = "production";
  vi.stubEnv("NODE_ENV", "production");
  delete process.env.CI;
}

function clearProductionEnvironment() {
  delete process.env.VERCEL_ENV;
  delete process.env.CI;
  vi.unstubAllEnvs();
}

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

describe("sendGoogleConversion — request payload", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll("value");
    process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID = "123456";
    stubProductionEnvironment();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    setAll(undefined);
    clearProductionEnvironment();
    vi.unstubAllGlobals();
  });

  function stubSuccessfulFetch() {
    const fetchSpy = vi.fn(async (url: unknown) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return { ok: true, json: async () => ({ access_token: "test-token" }) } as unknown as Response;
      }
      return { ok: true, status: 200, statusText: "OK" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  function conversionBody(fetchSpy: ReturnType<typeof vi.fn>) {
    const call = fetchSpy.mock.calls.find((args: unknown[]) => String(args[0]).includes("uploadClickConversions"));
    if (!call) throw new Error("uploadClickConversions was never called");
    const body = JSON.parse((call[1] as { body: string }).body);
    return body.conversions[0];
  }

  it("omits userIdentifiers entirely when userData is an empty object", async () => {
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, userData: {}, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.delivered).toBe(true);
    expect(conversionBody(fetchSpy)).not.toHaveProperty("userIdentifiers");
  });

  it("omits userIdentifiers entirely when every digest inside userData is undefined", async () => {
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: {
        name: "purchase",
        params: { transaction_id: "VL-1" },
        userData: { sha256_email_address: undefined },
        dedupeKey: null,
      },
      occurredAt: new Date(),
    });
    expect(result.delivered).toBe(true);
    expect(conversionBody(fetchSpy)).not.toHaveProperty("userIdentifiers");
  });

  it("includes userIdentifiers when at least one digest is present", async () => {
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    await sendGoogleConversion({
      event: {
        name: "purchase",
        params: { transaction_id: "VL-1" },
        userData: { sha256_email_address: "abc123" },
        dedupeKey: null,
      },
      occurredAt: new Date(),
    });
    expect(conversionBody(fetchSpy).userIdentifiers).toEqual([{ hashedEmail: "abc123" }]);
  });

  it("uses the numeric conversion action id, never the gtag label, in the resource name", async () => {
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(conversionBody(fetchSpy).conversionAction).toContain("/conversionActions/123456");
  });

  it("refuses to send when the conversion action id is not numeric", async () => {
    process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID = "AbC-D_efG";
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(result.message).toMatch(/numeric/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to send when the conversion action id is missing", async () => {
    delete process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID;
    const fetchSpy = stubSuccessfulFetch();
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendGoogleConversion — timeouts", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll("value");
    process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID = "123456";
    stubProductionEnvironment();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    setAll(undefined);
    clearProductionEnvironment();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A fetch that never settles on its own — only aborting its signal ends it. */
  function stubHangingFetch() {
    const fetchSpy = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  it("returns within the bound when Google hangs, instead of hanging the caller", async () => {
    vi.useFakeTimers();
    const fetchSpy = stubHangingFetch();
    const { sendGoogleConversion } = await import("./google-conversions");

    const pending = sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
      timeoutMs: 50,
    });

    // Proof the call would otherwise hang: nothing has settled before the bound.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.attempted).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.message).toBe("timed out");
    // Only the OAuth refresh fetch fired; the hang there means the upload call
    // never has a chance to happen, which is itself the point of bounding it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds the upload call too, once the OAuth leg succeeds", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return Promise.resolve({ ok: true, json: async () => ({ access_token: "test-token" }) } as unknown as Response);
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");

    const pending = sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.attempted).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.message).toBe("timed out");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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

  it("renders a timeout distinguishably from a rejection", async () => {
    const { describeGoogleResult } = await import("./google-conversions");
    const timedOut = describeGoogleResult({ attempted: false, delivered: false, code: null, message: "timed out" });
    const timedOutAfterAttempt = describeGoogleResult({
      attempted: true,
      delivered: false,
      code: null,
      message: "timed out",
    });
    const rejected = describeGoogleResult({
      attempted: true,
      delivered: false,
      code: 500,
      message: "Internal Server Error",
    });
    expect(timedOut).toMatch(/timed out/);
    expect(timedOutAfterAttempt).toMatch(/timed out/);
    expect(rejected).not.toMatch(/timed out/);
    expect(timedOut).not.toBe(rejected);
    expect(timedOutAfterAttempt).not.toBe(rejected);
  });
});

describe("environment enforcement — mutation control", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll("value");
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    setAll(undefined);
    clearProductionEnvironment();
    vi.unstubAllGlobals();
  });

  it("refuses to send from a non-production environment even fully credentialed", async () => {
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
  });

  it("refuses when VERCEL_ENV is unset, because 'we could not tell' is not 'production'", async () => {
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
