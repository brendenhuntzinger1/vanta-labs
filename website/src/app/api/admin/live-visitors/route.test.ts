import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ verifyAdminSessionFromRequest: vi.fn() }));
const liveVisitors = vi.hoisted(() => ({ getLiveVisitors: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({ verifyAdminSessionFromRequest: auth.verifyAdminSessionFromRequest }));
vi.mock("@/lib/admin-live-visitors", () => ({ getLiveVisitors: liveVisitors.getLiveVisitors }));

function makeRequest() {
  return new Request("https://vantalabsresearch.com/api/admin/live-visitors");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/live-visitors", () => {
  it("refuses an unauthenticated caller — never leaks who is on the site to a signed-out request", async () => {
    auth.verifyAdminSessionFromRequest.mockResolvedValue(null);
    const { GET } = await import("./route");

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(liveVisitors.getLiveVisitors).not.toHaveBeenCalled();
  });

  it("returns the live visitor list for a verified admin session", async () => {
    auth.verifyAdminSessionFromRequest.mockResolvedValue({ username: "owner" });
    liveVisitors.getLiveVisitors.mockResolvedValue([{ key: "session:s1", displayName: "Anonymous" }]);
    const { GET } = await import("./route");

    const res = await GET(makeRequest());
    const body = (await res.json()) as { success: boolean; visitors: unknown[] };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.visitors).toHaveLength(1);
  });

  it("degrades to a clean error instead of a raw 500 when the read fails", async () => {
    auth.verifyAdminSessionFromRequest.mockResolvedValue({ username: "owner" });
    liveVisitors.getLiveVisitors.mockRejectedValue(new Error('relation "website_analytics_events" does not exist'));
    const { GET } = await import("./route");

    const res = await GET(makeRequest());
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    // The raw Postgres relation name must not reach the response body.
    expect(body.error).not.toContain("website_analytics_events");
  });
});
