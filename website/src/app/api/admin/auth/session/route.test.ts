import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "AM I SIGNED IN?" IS A QUESTION, AND "NO" IS AN ANSWER — NOT A REFUSAL.
//
// This route answered 401 when the answer was simply no. Its own body already
// said `{"authenticated": false}`, so the status carried no information the
// caller did not already have; what it did carry was a red console error on
// every anonymous visit to /vault, and a line in production's 401 breakdown
// that looks exactly like a real refusal on an ADMIN auth path. That is the
// same defect the customer sign-in portal was cleared of earlier in this audit,
// on the same reasoning: a probe that always fails for the visitor who has not
// signed in yet trains whoever reads the logs to ignore the one signal that
// means something is wrong.
//
// The boundary is unchanged and is not in this route at all — it is
// verifyAdminSessionFromCookie, and no admin data crosses it either way. The
// only thing that moves is the status of the "no" answer.
// ---------------------------------------------------------------------------

const auth = vi.hoisted(() => ({ verifyAdminSessionFromCookie: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromCookie: auth.verifyAdminSessionFromCookie,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/auth/session", () => {
  it("answers an anonymous probe 200 with authenticated:false, not 401", async () => {
    auth.verifyAdminSessionFromCookie.mockResolvedValue(null);
    const { GET } = await import("./route");

    const res = await GET();
    const body = (await res.json()) as { authenticated: boolean; username?: string };

    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(false);
    // The refusal carried no name before and must carry none now.
    expect(body.username).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("names the admin only when the cookie actually verifies", async () => {
    auth.verifyAdminSessionFromCookie.mockResolvedValue({ username: "qaadmin" });
    const { GET } = await import("./route");

    const res = await GET();
    const body = (await res.json()) as { authenticated: boolean; username?: string };

    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe("qaadmin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

});
