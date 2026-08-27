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

  it("SERVER_INCOMPLETE with all six missing says the leg is dark, not 'incomplete'", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: {
        configured: false,
        missing: [
          "GOOGLE_ADS_DEVELOPER_TOKEN",
          "GOOGLE_ADS_CUSTOMER_ID",
          "GOOGLE_ADS_CLIENT_ID",
          "GOOGLE_ADS_CLIENT_SECRET",
          "GOOGLE_ADS_REFRESH_TOKEN",
          "GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID",
        ],
      },
    }).find((r) => r.id === "google-server");
    expect(row?.detail).toMatch(/not set/i);
    expect(row?.detail).not.toMatch(/incomplete/i);
    expect(row?.action).toMatch(/six/i);
  });

  it("SERVER_INCOMPLETE with exactly one missing names that one variable, not 'not set at all'", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: false, missing: ["GOOGLE_ADS_CUSTOMER_ID"] },
    }).find((r) => r.id === "google-server");
    expect(row?.detail).toMatch(/incomplete/i);
    expect(row?.detail).toContain("GOOGLE_ADS_CUSTOMER_ID");
    expect(row?.action).toContain("GOOGLE_ADS_CUSTOMER_ID");
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

  it("NOT_TESTED when credentialed and in production but nothing has been sent yet", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: null,
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("NOT_TESTED");
    expect(row?.detail).toMatch(/no conversion has been sent/i);
    expect(row?.action).toBeTruthy();
  });

  it("HEALTHY when configured, in production, and the last send delivered", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { attempted: true, delivered: true, code: 200, message: null },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("PASS");
  });

  it("HEALTHY never fabricates a response code it does not have", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { attempted: true, delivered: true, code: null, message: null },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("PASS");
    // No status was returned; the row must say so honestly rather than guess
    // "HTTP 200" — the same fallback wording the FAIL branch already used.
    expect(row?.detail).not.toContain("200");
    expect(row?.detail).toMatch(/no status/i);
  });

  it("ERROR carries Google's own status code", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { attempted: true, delivered: false, code: 401, message: "UNAUTHENTICATED" },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail).toContain("401");
  });

  it("never marks a row PLATFORM-verified without a response from Google in hand", () => {
    const rows = buildGoogleHealth({ ...base, conversionId: "AW-123456789" });
    expect(rows.filter((row) => row.tier === "PLATFORM")).toEqual([]);
  });

  it("a send that never reached Google is NOT_TESTED, not a rejection", () => {
    // sendGoogleConversion returns attempted:false when the OAuth refresh
    // itself failed or timed out before anything was ever sent to Google.
    // Nothing was communicated to Google either way, so this must never read
    // as "Google said no".
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { attempted: false, delivered: false, code: null, message: "oauth refresh failed" },
    }).find((r) => r.id === "google-server");
    expect(row?.status).not.toBe("FAIL");
    expect(row?.status).not.toBe("PASS");
    expect(row?.status).toBe("NOT_TESTED");
  });

  it("a timed-out upload is NOT_TESTED, not a rejection, even though attempted is true", () => {
    // sendGoogleConversion can return attempted:true with message:"timed out"
    // when the upload call itself was aborted before Google responded. This
    // is silence, not an answer, and must not collapse into FAIL.
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { attempted: true, delivered: false, code: null, message: "timed out" },
    }).find((r) => r.id === "google-server");
    expect(row?.status).not.toBe("FAIL");
    expect(row?.status).toBe("NOT_TESTED");
  });

  it("the backfill-contamination control: an unattempted suppression row must not read as delivered or FAIL", () => {
    // ads-purchase-ledger-per-platform.sql writes a `backfill-no-send` row
    // for historical orders that were never actually reported: nothing was
    // sent, so `attempted` is false and there is no code or message. This is
    // the exact shape an unfiltered ledger read would hand this builder if
    // Task 5's platform-scoped, backfill-excluding exclusion were ever
    // removed or bypassed upstream.
    //
    // This construction is deliberately the least dramatic possible
    // contamination — no delivered:true, no fabricated code — precisely so
    // the assertion below is only satisfied by code that actually inspects
    // `attempted`. A naive `delivered ? PASS : FAIL` implementation (the bug
    // this replaces) reads {attempted:false, delivered:false} as a rejection
    // and asserts FAIL, which is exactly what turns this test red: delete the
    // `!send.attempted` branch in google-health.ts (or stop threading
    // `attempted` through from the ledger reader) and this test starts
    // failing the `not.toBe("FAIL")` assertion.
    const contaminatedSuppressionRow = { attempted: false, delivered: false, code: null, message: null };
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: contaminatedSuppressionRow,
    }).find((r) => r.id === "google-server");
    expect(row?.status).not.toBe("FAIL");
    expect(row?.status).not.toBe("PASS");
    expect(row?.tier).not.toBe("PLATFORM");
  });

  it("every non-PASS state carries its own distinct action", () => {
    const inputs: Array<[string, Parameters<typeof buildGoogleHealth>[0]]> = [
      ["NOT_CONFIGURED", { ...base }],
      [
        "SERVER_INCOMPLETE",
        {
          ...base,
          conversionId: "AW-123456789",
          credentials: { configured: false, missing: ["GOOGLE_ADS_REFRESH_TOKEN"] },
        },
      ],
      [
        "SUPPRESSED_BY_ENVIRONMENT",
        {
          ...base,
          conversionId: "AW-123456789",
          credentials: { configured: true, missing: [] },
          environmentAllowed: false,
        },
      ],
      [
        "NOT_SENT_YET",
        { ...base, conversionId: "AW-123456789", credentials: { configured: true, missing: [] }, lastSend: null },
      ],
      [
        "ERROR",
        {
          ...base,
          conversionId: "AW-123456789",
          credentials: { configured: true, missing: [] },
          lastSend: { attempted: true, delivered: false, code: 401, message: "UNAUTHENTICATED" },
        },
      ],
    ];

    const actions = inputs.map(([name, input]) => {
      const rows = buildGoogleHealth(input);
      const action = rows[rows.length - 1]?.action;
      expect(action, `${name} should carry an action`).toBeTruthy();
      return action;
    });

    expect(new Set(actions).size).toBe(actions.length);
  });
});
