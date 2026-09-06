import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// /api/partner/program-stats IS THE ONE UNAUTHENTICATED ENDPOINT THAT SCANS
// FOUR TABLES.
//
// getPartnerProgramStats pages `partner_payouts` and `referral_orders` to
// exhaustion and reads `partners` and `partner_program_stats` whole, all with
// the service-role key. The route was `force-dynamic` with no cache and no rate
// limit, and the /partner landing page polls it every 30 seconds from every
// open tab — so the cost was (tabs x 2 per minute) x 4 table reads, growing
// with the ambassador program, payable by anyone on the internet with a `for`
// loop and no account.
//
// Production bore that out before launch: /api/partner/program-stats was the
// single busiest path in the runtime logs, 306 requests in six hours — one
// every seventy seconds — against a store with no traffic yet.
//
// These are public marketing counters. One read per minute per instance is the
// whole requirement; the client's own 30-second poll then costs a memory read.
// A read in flight is SHARED rather than duplicated, so a burst of concurrent
// requests is one query, not one each — that is the property that actually
// bounds a stampede. A FAILED read is never cached: a transient database blip
// must not be pinned in front of the page for the rest of the window.
// ---------------------------------------------------------------------------

const portal = vi.hoisted(() => ({ getPartnerProgramStats: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/partner-portal", () => ({
  getPartnerProgramStats: portal.getPartnerProgramStats,
}));

const STATS = { totalCommissionsPaid: 1234 } as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

async function body(res: Response) {
  return (await res.json()) as { success: boolean; stats?: Record<string, unknown>; error?: string };
}

describe("GET /api/partner/program-stats", () => {
  it("serves a second caller from cache instead of scanning the tables again", async () => {
    portal.getPartnerProgramStats.mockResolvedValue(STATS);
    const { GET } = await import("./route");

    const first = await body(await GET());
    const second = await body(await GET());

    expect(first.success).toBe(true);
    expect(second.stats).toEqual(STATS);
    expect(portal.getPartnerProgramStats).toHaveBeenCalledTimes(1);
  });

  it("shares one read across callers that arrive while it is still in flight", async () => {
    let release!: (value: unknown) => void;
    portal.getPartnerProgramStats.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { GET } = await import("./route");

    // Three anonymous requests land before the first read has come back. That
    // is the shape of a stampede, and it must cost one query.
    const responses = [GET(), GET(), GET()];
    release(STATS);
    const bodies = await Promise.all((await Promise.all(responses)).map(body));

    expect(portal.getPartnerProgramStats).toHaveBeenCalledTimes(1);
    for (const one of bodies) expect(one.stats).toEqual(STATS);
  });

  it("re-reads once the window has passed, so the numbers still move", async () => {
    portal.getPartnerProgramStats.mockResolvedValue(STATS);
    const { GET } = await import("./route");

    await GET();
    vi.advanceTimersByTime(61_000);
    await GET();

    expect(portal.getPartnerProgramStats).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure, and does not leak the database message", async () => {
    portal.getPartnerProgramStats.mockRejectedValueOnce(
      new Error('relation "partner_payouts" does not exist'),
    );
    const { GET } = await import("./route");

    const failed = await body(await GET());
    expect(failed.success).toBe(false);
    expect(failed.error).not.toContain("relation");

    // The very next request retries rather than serving the failure for a
    // minute.
    portal.getPartnerProgramStats.mockResolvedValue(STATS);
    const recovered = await body(await GET());
    expect(recovered.success).toBe(true);
    expect(recovered.stats).toEqual(STATS);
    expect(portal.getPartnerProgramStats).toHaveBeenCalledTimes(2);
  });
});
