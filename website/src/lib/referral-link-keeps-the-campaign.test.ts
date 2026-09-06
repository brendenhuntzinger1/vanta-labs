import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN AD THAT LANDS ON AN AMBASSADOR LINK KEPT ITS AMBASSADOR AND LOST ITS AD.
//
// /r/<code> redirects to a path with no query, so `?utm_source=meta&ttclid=…`
// on the incoming link died at this route. The click row recorded three UTMs —
// and only when the visitor had accepted analytics — but the LANDING page never
// saw the parameters, and the landing page is the only thing that writes the
// visitor's attribution touch (site-analytics-tracker.tsx reads
// window.location.search).
//
// So an ambassador running paid traffic to their own link produced orders that
// read as ORGANIC: no spend joined to them in ad_revenue_daily, no ROAS for the
// creative that paid for the click, and the ttclid/fbclid that the platforms'
// conversion APIs need was gone before anything could store it. Ambassadors
// running paid social to their code is the normal case, not an edge one.
//
// Forwarded by ALLOWLIST, not wholesale: this is a public, widely shared link
// that redirects to an internal path, and it must not become a way to put
// arbitrary query parameters on one.
// ---------------------------------------------------------------------------

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { from: () => ({ insert: async () => ({ error: null }) }) },
}));
vi.mock("@/lib/referral-code-service", () => ({
  resolveReferralCode: vi.fn(async (code: string) =>
    code === "UNKNOWN" ? null : { ambassadorId: "amb-1", currentCode: "LIVE10" },
  ),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/admin-auth", () => ({ getRequestIpAddress: () => "203.0.113.9" }));

async function landing(query: string, code = "LIVE10"): Promise<URL> {
  const { GET } = await import("@/app/r/[code]/route");
  const request = new Request(`https://vantalabsresearch.com/r/${code}${query}`);
  const response = await GET(request, { params: Promise.resolve({ code }) });
  return new URL(String(response.headers.get("location")));
}

beforeEach(() => { vi.clearAllMocks(); });

describe("the campaign travels to the landing page", () => {
  it.each([
    ["utm_source", "meta"],
    ["utm_medium", "paid_social"],
    ["utm_campaign", "spring-launch"],
    ["utm_content", "vial-hero-9x16"],
    ["utm_term", "peptide"],
  ])("forwards %s", async (key, value) => {
    const to = await landing(`?${key}=${encodeURIComponent(value)}`);
    expect(to.searchParams.get(key)).toBe(value);
  });

  it.each([
    ["ttclid", "E.C.P.abc123"],
    ["fbclid", "IwAR0xyz"],
    ["gclid", "Cj0KCQ"],
    ["rdt_cid", "rdt-9911"],
    ["ScCid", "snap-42"],
  ])("forwards the %s click id, which the conversion API cannot be sent without", async (key, value) => {
    const to = await landing(`?${key}=${encodeURIComponent(value)}`);
    expect(to.searchParams.get(key)).toBe(value);
  });

  it("carries a whole paid link at once, onto the default destination", async () => {
    const to = await landing("?utm_source=tiktok&utm_medium=paid&utm_campaign=q3&utm_content=ugc7&ttclid=abc");
    expect(to.pathname).toBe("/products");
    expect(Object.fromEntries(to.searchParams)).toEqual({
      utm_source: "tiktok",
      utm_medium: "paid",
      utm_campaign: "q3",
      utm_content: "ugc7",
      ttclid: "abc",
    });
  });

  it("carries them onto an explicit next=, keeping that path", async () => {
    const to = await landing("?next=/products/bpc-157&utm_source=meta&fbclid=xyz");
    expect(to.pathname).toBe("/products/bpc-157");
    expect(to.searchParams.get("utm_source")).toBe("meta");
    expect(to.searchParams.get("fbclid")).toBe("xyz");
  });
});

describe("what does NOT travel", () => {
  it("forwards nothing else, so this cannot put arbitrary parameters on an internal path", async () => {
    const to = await landing("?utm_source=meta&admin=1&token=secret&debug=true&next=/products");
    expect(to.searchParams.get("admin")).toBeNull();
    expect(to.searchParams.get("token")).toBeNull();
    expect(to.searchParams.get("debug")).toBeNull();
    expect(to.searchParams.get("utm_source")).toBe("meta");
  });

  it("does not carry `next` itself through to the destination", async () => {
    const to = await landing("?next=/products&utm_source=meta");
    expect(to.searchParams.get("next")).toBeNull();
  });

  it("still refuses an off-site next, campaign or no campaign", async () => {
    const to = await landing("?next=https://evil.example/steal&utm_source=meta");
    expect(to.origin).toBe("https://vantalabsresearch.com");
    expect(to.pathname).toBe("/products");
  });

  it("leaves an unknown code's redirect tagged too, since the visit is still a visit", async () => {
    // No ambassador is credited, but the ad that paid for the click still is.
    const to = await landing("?utm_source=meta&ttclid=abc", "UNKNOWN");
    expect(to.searchParams.get("utm_source")).toBe("meta");
    expect(to.searchParams.get("ttclid")).toBe("abc");
  });

  it("adds nothing at all to an untagged link", async () => {
    const to = await landing("");
    expect(to.pathname).toBe("/products");
    expect([...to.searchParams.keys()]).toEqual([]);
  });
});

describe("a next= that already carries a tag keeps its own value", () => {
  it("does not overwrite it from the outer link", async () => {
    const to = await landing("?next=%2Fproducts%3Futm_source%3Demail&utm_source=meta");
    expect(to.searchParams.get("utm_source")).toBe("email");
  });
});
