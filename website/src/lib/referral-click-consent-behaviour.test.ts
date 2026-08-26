import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-04, asserted on WHAT IS ACTUALLY WRITTEN.
//
// The companion suite (referral-click-consent.test.ts) reads the source. That
// caught the shape of the fix but not its behaviour: a mutation replacing
// `const tracking = analyticsConsented ? {...}` with `const tracking = true ?
// {...}` — i.e. reinstating the exact defect — left every source assertion
// still true and survived.
//
// This suite calls the real route handler and inspects the rows it inserts.
// That is the only assertion that cannot be satisfied by code which merely
// mentions consent while ignoring it.
// ---------------------------------------------------------------------------

const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return { error: null };
      },
    }),
  },
}));

vi.mock("@/lib/referral-code-service", () => ({
  resolveReferralCode: vi.fn(async (code: string) =>
    code === "UNKNOWN" ? null : { ambassadorId: "amb-1", currentCode: "LIVE10" },
  ),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getRequestIpAddress: () => "203.0.113.9",
}));

const TRACKING_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "referrer", "user_agent", "ip_address"] as const;

async function click(opts: { cookie?: string } = {}) {
  const { GET } = await import("@/app/r/[code]/route");
  const request = new Request(
    "https://vantalabsresearch.com/r/LIVE10?next=/products&utm_source=tiktok&utm_medium=bio&utm_campaign=spring",
    {
      headers: {
        referer: "https://www.tiktok.com/@someone",
        "user-agent": "Mozilla/5.0 (harness)",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    },
  );
  const response = await GET(request, { params: Promise.resolve({ code: "LIVE10" }) });
  return { response, rows: [...inserted] };
}

beforeEach(() => {
  inserted.length = 0;
  vi.clearAllMocks();
});

describe("what an affiliate click writes when consent was NOT given", () => {
  it("records no campaign parameters, no referrer, no user agent and no IP for a visitor who declined", async () => {
    const { rows } = await click({ cookie: "vl_cookie_consent=declined" });

    expect(rows.length, "both the click table and the referrals table are written").toBe(2);
    for (const { table, row } of rows) {
      for (const field of TRACKING_FIELDS) {
        expect(row[field], `${table}.${field} must not be recorded without consent`).toBeUndefined();
      }
    }
  });

  it("records none of it for a visitor who has not answered the banner yet", async () => {
    // No consent cookie at all. This is the majority case on a first visit and
    // the one the old code was most wrong about.
    const { rows } = await click();

    expect(rows.length).toBe(2);
    for (const { row } of rows) {
      for (const field of TRACKING_FIELDS) {
        expect(row[field]).toBeUndefined();
      }
    }
  });

  it("still attributes the click to the ambassador and still sets the referral cookie", async () => {
    // The negative control that keeps this from becoming a revenue bug: an
    // ambassador is still credited for a click from someone who declined.
    const { response, rows } = await click({ cookie: "vl_cookie_consent=declined" });

    expect(rows.map((r) => r.table).sort()).toEqual(["partner_clicks", "referrals"]);
    expect(rows[0].row.ambassador_id).toBe("amb-1");
    expect(rows[0].row.referral_code).toBe("LIVE10");
    expect(rows[0].row.landing_path).toBe("/products");
    expect(String(response.headers.get("set-cookie") ?? "")).toContain("vl_referral_code=LIVE10");
  });
});

describe("what an affiliate click writes when consent WAS given", () => {
  it("records the full analytics payload", async () => {
    const { rows } = await click({ cookie: "vl_cookie_consent=accepted" });

    expect(rows.length).toBe(2);
    for (const { table, row } of rows) {
      expect(row.utm_source, `${table}`).toBe("tiktok");
      expect(row.utm_medium).toBe("bio");
      expect(row.utm_campaign).toBe("spring");
      expect(row.referrer).toBe("https://www.tiktok.com/@someone");
      expect(row.user_agent).toBe("Mozilla/5.0 (harness)");
      expect(row.ip_address).toBe("203.0.113.9");
    }
  });

  it("finds the consent cookie alongside the referral cookie a returning visitor already carries", async () => {
    const { rows } = await click({ cookie: "vl_referral_code=OLD; vl_cookie_consent=accepted; other=1" });
    expect(rows[0].row.utm_source).toBe("tiktok");
  });
});

describe("an unknown code is not attributed at all", () => {
  it("writes nothing and still redirects", async () => {
    const { GET } = await import("@/app/r/[code]/route");
    const response = await GET(
      new Request("https://vantalabsresearch.com/r/UNKNOWN?utm_source=tiktok", {
        headers: { cookie: "vl_cookie_consent=accepted" },
      }),
      { params: Promise.resolve({ code: "UNKNOWN" }) },
    );

    expect(inserted).toHaveLength(0);
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
  });
});
