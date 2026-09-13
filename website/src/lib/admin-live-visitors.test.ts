import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// This exercises the I/O WIRING of getLiveVisitors() — two queries against
// website_analytics_events composed correctly, and name resolution merged
// in for signed-in visitors. The dedup/grouping RULES themselves (multi-tab,
// multi-device, login/logout, staleness, bot/admin exclusion) are unit-
// tested exhaustively and independently in live-visitor-grouping.test.ts;
// this file does not re-prove them.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let activityRows: Row[] = [];
let sessionStartRows: Row[] = [];
let usersById: Record<string, { email?: string; user_metadata?: Record<string, unknown> }> = {};

// Distinguishes the two queries by the columns they SELECT, rather than by
// call order — robust regardless of how many times getLiveVisitors() has
// been invoked across tests in this file, and lets beforeEach's row resets
// just work.
function chainable() {
  let selected = "";
  const builder: PromiseLike<{ data: Row[]; error: null }> & Record<string, (...args: unknown[]) => unknown> = {
    select: (columns: string) => {
      selected = columns;
      return builder;
    },
    gte: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown) => {
      const rows = selected.includes("page_path") ? activityRows : sessionStartRows;
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    },
  } as never;
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (_table: string) => chainable(),
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: usersById[id] ? { id, ...usersById[id] } : null } }),
      },
    },
  },
}));

beforeEach(() => {
  activityRows = [];
  sessionStartRows = [];
  usersById = {};
});

describe("getLiveVisitors", () => {
  it("returns an empty list when nobody is live", async () => {
    const { getLiveVisitors } = await import("./admin-live-visitors");
    expect(await getLiveVisitors()).toEqual([]);
  });

  it("shows an anonymous visitor with coarse location and no name", async () => {
    activityRows = [
      {
        session_id: "s1",
        user_id: null,
        page_path: "/products/recon-water",
        device_type: "mobile",
        user_agent: "Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36",
        country: "US",
        city: "Austin",
        is_bot: false,
        created_at: new Date().toISOString(),
      },
    ];
    sessionStartRows = [{ session_id: "s1", created_at: new Date().toISOString(), utm_source: "google", utm_medium: "cpc", utm_campaign: null }];

    const { getLiveVisitors } = await import("./admin-live-visitors");
    const visitors = await getLiveVisitors();

    expect(visitors).toHaveLength(1);
    expect(visitors[0].isAnonymous).toBe(true);
    expect(visitors[0].displayName).toBe("Anonymous");
    expect(visitors[0].location).toBe("Austin, US");
    expect(visitors[0].pagePath).toBe("/products/recon-water");
    expect(visitors[0].browserClass).toBe("Chrome");
    expect(visitors[0].utmSource).toBe("google");
  });

  it("resolves a real name for a signed-in customer, never trusting a stored name field", async () => {
    activityRows = [
      {
        session_id: "s2",
        user_id: "cust-1",
        page_path: "/account",
        device_type: "desktop",
        user_agent: "Mozilla/5.0",
        country: "US",
        city: null,
        is_bot: false,
        created_at: new Date().toISOString(),
      },
    ];
    sessionStartRows = [{ session_id: "s2", created_at: new Date().toISOString(), utm_source: null, utm_medium: null, utm_campaign: null }];
    usersById = { "cust-1": { email: "jane@example.com", user_metadata: { full_name: "Jane Doe" } } };

    const { getLiveVisitors } = await import("./admin-live-visitors");
    const visitors = await getLiveVisitors();

    expect(visitors[0].isAnonymous).toBe(false);
    expect(visitors[0].displayName).toBe("Jane Doe");
  });

  it("falls back to email, then a generic label, when no full name is on file", async () => {
    activityRows = [
      {
        session_id: "s3",
        user_id: "cust-2",
        page_path: "/",
        device_type: "desktop",
        user_agent: "Mozilla/5.0",
        country: null,
        city: null,
        is_bot: false,
        created_at: new Date().toISOString(),
      },
    ];
    sessionStartRows = [{ session_id: "s3", created_at: new Date().toISOString(), utm_source: null, utm_medium: null, utm_campaign: null }];
    usersById = { "cust-2": { email: "no-name@example.com" } };

    const { getLiveVisitors } = await import("./admin-live-visitors");
    expect((await getLiveVisitors())[0].displayName).toBe("no-name@example.com");
  });

  it("never crashes the whole read when one visitor's name lookup fails", async () => {
    activityRows = [
      {
        session_id: "s4",
        user_id: "cust-missing",
        page_path: "/",
        device_type: "desktop",
        user_agent: "Mozilla/5.0",
        country: null,
        city: null,
        is_bot: false,
        created_at: new Date().toISOString(),
      },
    ];
    sessionStartRows = [{ session_id: "s4", created_at: new Date().toISOString(), utm_source: null, utm_medium: null, utm_campaign: null }];
    usersById = {}; // getUserById resolves with a null user — account deleted, etc.

    const { getLiveVisitors } = await import("./admin-live-visitors");
    const visitors = await getLiveVisitors();
    expect(visitors).toHaveLength(1);
    expect(visitors[0].displayName).toBe("Signed-in visitor");
  });

  it("never returns the raw user agent string to the caller", async () => {
    activityRows = [
      {
        session_id: "s5",
        user_id: null,
        page_path: "/",
        device_type: "desktop",
        user_agent: "Mozilla/5.0 (Very Specific Fingerprintable String) Chrome/128.0.0.0",
        country: null,
        city: null,
        is_bot: false,
        created_at: new Date().toISOString(),
      },
    ];
    sessionStartRows = [{ session_id: "s5", created_at: new Date().toISOString(), utm_source: null, utm_medium: null, utm_campaign: null }];

    const { getLiveVisitors } = await import("./admin-live-visitors");
    const visitors = await getLiveVisitors();
    expect(JSON.stringify(visitors)).not.toContain("Fingerprintable");
    expect(visitors[0].browserClass).toBe("Chrome");
  });
});

describe("pruneStaleHeartbeats", () => {
  it("deletes only stale heartbeat rows and reports how many", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        from: (_table: string) => {
          const calls: string[] = [];
          const builder: Record<string, (...args: unknown[]) => unknown> = {
            delete: () => {
              calls.push("delete");
              return builder;
            },
            eq: (...args: unknown[]) => {
              expect(args[0]).toBe("event_type");
              expect(args[1]).toBe("heartbeat");
              return builder;
            },
            lt: () => builder,
            select: () => Promise.resolve({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }),
          };
          return builder;
        },
        auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
      },
    }));

    vi.resetModules();
    const { pruneStaleHeartbeats } = await import("./admin-live-visitors");
    expect(await pruneStaleHeartbeats()).toBe(3);
  });

  it("throws (rather than swallowing) a real database error", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        from: () => {
          const builder: Record<string, (...args: unknown[]) => unknown> = {
            delete: () => builder,
            eq: () => builder,
            lt: () => builder,
            select: () => Promise.resolve({ data: null, error: new Error("connection lost") }),
          };
          return builder;
        },
      },
    }));

    vi.resetModules();
    const { pruneStaleHeartbeats } = await import("./admin-live-visitors");
    await expect(pruneStaleHeartbeats()).rejects.toThrow("connection lost");
  });
});
