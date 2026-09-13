import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ONE PROPERTY THAT MATTERS MOST HERE: identity on a heartbeat/page_view
// row comes ONLY from the server-verified session cookie, never from
// anything the request body claims — even when the body tries to claim one.
// These tests exercise the real route handler (not a source-text check),
// with only its DB/session/rate-limit dependencies doubled.
// ---------------------------------------------------------------------------

const insertedRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return { error: null };
      },
    }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

const mockGetAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: () => mockGetAuthenticatedUser(),
}));

function jsonRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://vantalabsresearch.com/api/analytics/track", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  insertedRows.length = 0;
  mockGetAuthenticatedUser.mockReset();
  mockGetAuthenticatedUser.mockResolvedValue(null);
});

describe("POST /api/analytics/track — heartbeat", () => {
  it("accepts the heartbeat event type", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      jsonRequest({ eventType: "heartbeat", sessionId: "s1", pagePath: "/products/recon-water" }),
    );
    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].event_type).toBe("heartbeat");
  });

  it("ignores a client-claimed identity entirely — anonymous session cookie means null user_id, always", async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const { POST } = await import("./route");
    await POST(
      jsonRequest({
        eventType: "heartbeat",
        sessionId: "s1",
        pagePath: "/",
        // None of these are real fields the route reads — the point is that
        // even if a client tried to smuggle an identity in, there is no path
        // from this body to the stored user_id.
        userId: "someone-elses-id",
        user_id: "someone-elses-id",
        role: "admin",
      }),
    );
    expect(insertedRows[0].user_id).toBeNull();
  });

  it("stamps the row with the SERVER-verified customer id when the session cookie says so", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: "real-customer-id", app_metadata: {}, user_metadata: {} });
    const { POST } = await import("./route");
    await POST(jsonRequest({ eventType: "heartbeat", sessionId: "s1", pagePath: "/" }));
    expect(insertedRows[0].user_id).toBe("real-customer-id");
  });

  it("never names an admin/staff session as a visitor, even though they are signed in", async () => {
    mockGetAuthenticatedUser.mockResolvedValue({
      id: "staff-id",
      app_metadata: { role: "admin" },
      user_metadata: {},
    });
    const { POST } = await import("./route");
    await POST(jsonRequest({ eventType: "heartbeat", sessionId: "s1", pagePath: "/admin" }));
    expect(insertedRows[0].user_id).toBeNull();
  });

  it("derives country/city from Vercel's geo headers, not from the request body", async () => {
    const { POST } = await import("./route");
    await POST(
      jsonRequest(
        { eventType: "heartbeat", sessionId: "s1", pagePath: "/", country: "ZZ", city: "Nowhere" },
        { "x-vercel-ip-country": "US", "x-vercel-ip-city": "Austin" },
      ),
    );
    expect(insertedRows[0].country).toBe("US");
    expect(insertedRows[0].city).toBe("Austin");
  });

  it("never stores a raw IP address for a heartbeat row", async () => {
    const { POST } = await import("./route");
    await POST(
      jsonRequest(
        { eventType: "heartbeat", sessionId: "s1", pagePath: "/" },
        { "x-forwarded-for": "203.0.113.7" },
      ),
    );
    expect(insertedRows[0].ip_address).toBeNull();
  });

  it("classifies an obvious bot user agent as is_bot", async () => {
    const { POST } = await import("./route");
    await POST(
      jsonRequest(
        { eventType: "heartbeat", sessionId: "s1", pagePath: "/" },
        { "user-agent": "python-requests/2.31.0" },
      ),
    );
    expect(insertedRows[0].is_bot).toBe(true);
  });

  it("does not flag an ordinary browser as a bot", async () => {
    const { POST } = await import("./route");
    await POST(
      jsonRequest(
        { eventType: "heartbeat", sessionId: "s1", pagePath: "/" },
        {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        },
      ),
    );
    expect(insertedRows[0].is_bot).toBe(false);
  });
});
