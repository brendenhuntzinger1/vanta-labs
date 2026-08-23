import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE LOCK ON EVERY ADMIN ROUTE.
//
// 73 of the 75 routes under /api/admin call verifyAdminSessionFromRequest
// (login and logout correctly do not). Between them they adjust inventory,
// buy postage, create replacements, read profit, change shipping settings and
// broadcast email. This function is the only thing standing in front of all
// of them.
//
// WHY THIS FILE EXISTS
//
// Making the verifier return a valid owner session unconditionally -- handing
// every anonymous caller on the internet full owner access to all 73 routes --
// left ALL 2,625 existing tests green. The lock was correct and entirely
// unproven.
//
// These tests drive the real verifier against a mocked Supabase, so they
// exercise the actual code path an admin request takes. Every case was
// confirmed to fail when its protection is removed.
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  username: string;
  expires_at: string;
}

const state: {
  session: SessionRow | null;
  credential: { role: string; is_active: boolean } | null;
  sessionQuery: { tokenHash?: string; expiresAfter?: string };
  deletedForUsername: string[];
  lastSeenUpdates: string[];
  throwOnSelect: boolean;
} = {
  session: null,
  credential: null,
  sessionQuery: {},
  deletedForUsername: [],
  lastSeenUpdates: [],
  throwOnSelect: false,
};

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "admin_sessions") {
      return {
        select: () => ({
          eq: (_col: string, value: string) => {
            state.sessionQuery.tokenHash = value;
            return {
              gt: (_c: string, iso: string) => {
                state.sessionQuery.expiresAfter = iso;
                return {
                  maybeSingle: async () => {
                    if (state.throwOnSelect) throw new Error("supabase is down");
                    return { data: state.session, error: null };
                  },
                };
              },
            };
          },
        }),
        update: (payload: Record<string, unknown>) => {
          state.lastSeenUpdates.push(String(payload.last_seen_at));
          return { eq: async () => ({ error: null }) };
        },
        delete: () => ({
          eq: async (_col: string, value: string) => {
            state.deletedForUsername.push(value);
            return { error: null };
          },
        }),
      };
    }
    if (table === "admin_credentials") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.credential, error: null }) }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { supabaseAdmin: { from } };
});

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const GOOD_TOKEN = "a".repeat(64);

function grantValidSession() {
  state.session = { id: "sess-1", username: "owner-account", expires_at: FUTURE };
  state.credential = { role: "super_admin", is_active: true };
}

function cookieRequest(cookie: string | null) {
  return new Request("https://example.test/api/admin/anything", {
    headers: cookie === null ? {} : { cookie },
  });
}

beforeEach(() => {
  state.session = null;
  state.credential = null;
  state.sessionQuery = {};
  state.deletedForUsername = [];
  state.lastSeenUpdates = [];
  state.throwOnSelect = false;
});

async function verifyToken(token: string | null | undefined) {
  const { verifyAdminSessionToken } = await import("@/lib/admin-auth");
  return verifyAdminSessionToken(token);
}

async function verifyRequest(cookie: string | null) {
  const { verifyAdminSessionFromRequest } = await import("@/lib/admin-auth");
  return verifyAdminSessionFromRequest(cookieRequest(cookie));
}

describe("an admin session is only granted to a real, live, unexpired session", () => {
  it("grants access for a stored, unexpired session on an active account", async () => {
    grantValidSession();
    const result = await verifyToken(GOOD_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.username).toBe("owner-account");
    expect(result?.role).toBe("super_admin");
  });

  it("degrades an unrecognised stored role to the least-privileged one", async () => {
    state.session = { id: "sess-1", username: "odd-account", expires_at: FUTURE };
    state.credential = { role: "wizard", is_active: true };
    // A typo or a stale role name must not become an escalation.
    expect((await verifyToken(GOOD_TOKEN))?.role).toBe("staff");
  });

  describe("denies", () => {
    it("denies a null token", async () => {
      grantValidSession(); // even with a session in the table
      expect(await verifyToken(null)).toBeNull();
    });

    it("denies an empty token", async () => {
      grantValidSession();
      expect(await verifyToken("")).toBeNull();
    });

    it("denies an undefined token", async () => {
      grantValidSession();
      expect(await verifyToken(undefined)).toBeNull();
    });

    it("denies a token that matches no stored session", async () => {
      state.session = null;
      state.credential = { role: "super_admin", is_active: true };
      expect(await verifyToken("forged-token")).toBeNull();
    });
  });

  describe("the token is never used raw", () => {
    it("looks the session up by a hash, not by the token itself", async () => {
      grantValidSession();
      await verifyToken(GOOD_TOKEN);
      // A stolen database dump must not yield usable session cookies.
      expect(state.sessionQuery.tokenHash).toBeDefined();
      expect(state.sessionQuery.tokenHash).not.toBe(GOOD_TOKEN);
      expect(state.sessionQuery.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("gives different tokens different lookups", async () => {
      grantValidSession();
      await verifyToken(GOOD_TOKEN);
      const first = state.sessionQuery.tokenHash;
      await verifyToken("b".repeat(64));
      expect(state.sessionQuery.tokenHash).not.toBe(first);
    });
  });

  describe("expiry is enforced in the query, not after the fact", () => {
    it("constrains the lookup to sessions expiring in the future", async () => {
      grantValidSession();
      const before = new Date().toISOString();
      await verifyToken(GOOD_TOKEN);
      expect(state.sessionQuery.expiresAfter).toBeDefined();
      expect(state.sessionQuery.expiresAfter! >= before).toBe(true);
    });
  });

  describe("an account that should no longer have access", () => {
    it("denies a session whose account has been deactivated", async () => {
      state.session = { id: "sess-1", username: "fired-admin", expires_at: FUTURE };
      state.credential = { role: "owner", is_active: false };
      expect(await verifyToken(GOOD_TOKEN)).toBeNull();
    });

    it("denies a session whose account no longer exists", async () => {
      state.session = { id: "sess-1", username: "deleted-admin", expires_at: FUTURE };
      state.credential = null;
      expect(await verifyToken(GOOD_TOKEN)).toBeNull();
    });

    it("purges the lingering sessions of a deactivated account", async () => {
      state.session = { id: "sess-1", username: "fired-admin", expires_at: FUTURE };
      state.credential = { role: "owner", is_active: false };
      await verifyToken(GOOD_TOKEN);
      // Offboarding must take effect now, not when the 12h TTL lapses.
      expect(state.deletedForUsername).toContain("fired-admin");
    });
  });

  describe("when the database is unreachable", () => {
    it("fails CLOSED rather than throwing or granting access", async () => {
      grantValidSession();
      state.throwOnSelect = true;
      // A transient Supabase error must deny, not crash every admin route and
      // not wave the caller through.
      await expect(verifyToken(GOOD_TOKEN)).resolves.toBeNull();
    });
  });

  describe("reading the session out of the request cookie", () => {
    it("grants access when the admin session cookie is present and valid", async () => {
      grantValidSession();
      const result = await verifyRequest(`vl_admin_session=${GOOD_TOKEN}`);
      expect(result).not.toBeNull();
    });

    it("denies a request with no cookie header at all", async () => {
      grantValidSession();
      expect(await verifyRequest(null)).toBeNull();
    });

    it("denies a request whose cookies do not include the admin session", async () => {
      grantValidSession();
      expect(await verifyRequest("other_cookie=value; another=thing")).toBeNull();
    });

    it("does not accept a different cookie whose name merely contains the session name", async () => {
      grantValidSession();
      expect(await verifyRequest(`not_vl_admin_session=${GOOD_TOKEN}`)).toBeNull();
    });

    it("reads the session cookie when it is not the first one", async () => {
      grantValidSession();
      const result = await verifyRequest(`a=1; vl_admin_session=${GOOD_TOKEN}; b=2`);
      expect(result).not.toBeNull();
      expect(state.sessionQuery.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
