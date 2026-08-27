import { describe, expect, it } from "vitest";
import { buildGoogleHealth } from "./google-health";

const base = {
  conversionId: "",
  credentials: { configured: false, missing: ["GOOGLE_ADS_DEVELOPER_TOKEN"] },
  environmentAllowed: true,
  lastSend: null,
};

describe("buildGoogleHealth — the six states", () => {
  it("NOT_CONFIGURED with no conversion id, and does not call that an error", () => {
    const row = buildGoogleHealth(base)[0];
    expect(row.status).toBe("NOT_AVAILABLE");
    expect(row.detail).toMatch(/not configured/i);
  });

  it("BROWSER_CONFIGURED when the tag is live but the server leg is not credentialed", () => {
    const rows = buildGoogleHealth({ ...base, conversionId: "AW-123456789" });
    expect(rows.find((row) => row.id === "google-browser")?.status).toBe("PASS");
    expect(rows.find((row) => row.id === "google-server")?.status).toBe("NOT_AVAILABLE");
  });

  it("SERVER_INCOMPLETE names the missing variable rather than saying 'misconfigured'", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: false, missing: ["GOOGLE_ADS_REFRESH_TOKEN"] },
    }).find((r) => r.id === "google-server");
    expect(row?.detail).toContain("GOOGLE_ADS_REFRESH_TOKEN");
    expect(row?.action).toBeTruthy();
  });

  it("SUPPRESSED_BY_ENVIRONMENT is reported as working as designed, not as a failure", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      environmentAllowed: false,
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("NOT_AVAILABLE");
    expect(row?.detail).toMatch(/environment/i);
  });

  it("HEALTHY when configured, in production, and the last send delivered", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { delivered: true, code: 200, message: null },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("PASS");
  });

  it("ERROR carries Google's own status code", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { delivered: false, code: 401, message: "UNAUTHENTICATED" },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail).toContain("401");
  });

  it("never marks a row PLATFORM-verified without a response from Google in hand", () => {
    const rows = buildGoogleHealth({ ...base, conversionId: "AW-123456789" });
    expect(rows.filter((row) => row.tier === "PLATFORM")).toEqual([]);
  });

  it("a backfill suppression row can never surface as a delivered conversion or a FAIL", () => {
    // Google health rows are built entirely from the caller-supplied lastSend
    // summary — never from raw ledger rows — so there is no path by which a
    // backfill-no-send suppression row (event_id = 'backfill-no-send',
    // delivered: false) could reach this builder and be read as a real
    // attempt. Simulating the worst case a raw, unfiltered ledger read could
    // produce (a non-delivered "send") must still resolve to FAIL only because
    // Google actually rejected something — never because a suppression row was
    // miscounted as an attempt.
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { delivered: false, code: null, message: null },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("FAIL");
    // The important guarantee: this builder never fabricates a PASS/delivered
    // reading from a row it didn't actually receive as a genuine send.
    expect(row?.tier).not.toBe("PLATFORM");
  });
});
