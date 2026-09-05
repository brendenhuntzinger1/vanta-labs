import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The partner routes echoed `error.message` verbatim. A failed read against the
// database therefore handed an ambassador a Postgres or vendor message. They now
// run through customerSafeMessage like the customer routes — and the messages
// that WERE written for the ambassador ("Only approved ambassadors…", the payout
// validation hints) still arrive intact.
// ---------------------------------------------------------------------------

const portal = vi.hoisted(() => ({
  getPartnerByAuthUserId: vi.fn(),
  getApprovedPartnerByAuthUserId: vi.fn(),
  updatePartnerPayoutMethod: vi.fn(),
  changeOwnReferralCode: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({ getAuthenticatedUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/admin-auth", () => ({ getRequestIpAddress: () => "203.0.113.5" }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/partner-portal", () => ({
  getPartnerByAuthUserId: portal.getPartnerByAuthUserId,
  getApprovedPartnerByAuthUserId: portal.getApprovedPartnerByAuthUserId,
  updatePartnerPayoutMethod: portal.updatePartnerPayoutMethod,
}));
vi.mock("@/lib/referral-code-service", () => ({ changeOwnReferralCode: portal.changeOwnReferralCode }));

const { CustomerFacingError } = await import("@/lib/safe-error");

const PG_LEAK = 'null value in column "payout_handle" of relation "partners" violates not-null constraint';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function json(res: Response) {
  return (await res.json()) as { success: boolean; error?: string };
}

describe("GET /api/partner/me", () => {
  it("never echoes a database message", async () => {
    portal.getPartnerByAuthUserId.mockRejectedValue(new Error(PG_LEAK));
    const { GET } = await import("./me/route");
    const body = await json(await GET());

    expect(body.success).toBe(false);
    expect(body.error).toBe("Unable to load partner profile");
    expect(body.error).not.toContain("relation");
  });
});

describe("POST /api/partner/payout-method", () => {
  const request = (method: string, handle: string) =>
    new Request("http://localhost/api/partner/payout-method", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, handle }),
    });

  it("keeps the PayPal validation hint intact, hostname-looking example and all", async () => {
    portal.getApprovedPartnerByAuthUserId.mockResolvedValue({ id: "p-1" });
    const hint = "Enter the email address on your PayPal account (like name@example.com).";
    portal.updatePartnerPayoutMethod.mockRejectedValue(new CustomerFacingError(hint));
    const { POST } = await import("./payout-method/route");
    const body = await json(await POST(request("paypal", "not-an-email")));

    expect(body.error).toBe(hint);
  });

  it("keeps the invalid-method message", async () => {
    portal.getApprovedPartnerByAuthUserId.mockResolvedValue({ id: "p-1" });
    const message = "Choose a valid payout method: PayPal, Venmo, or Cash App.";
    portal.updatePartnerPayoutMethod.mockRejectedValue(new CustomerFacingError(message));
    const { POST } = await import("./payout-method/route");
    const body = await json(await POST(request("bitcoin", "x")));

    expect(body.error).toBe(message);
  });

  it("replaces a database failure with Vanta's words", async () => {
    portal.getApprovedPartnerByAuthUserId.mockResolvedValue({ id: "p-1" });
    portal.updatePartnerPayoutMethod.mockRejectedValue(new Error(PG_LEAK));
    const { POST } = await import("./payout-method/route");
    const body = await json(await POST(request("paypal", "me@example.com")));

    expect(body.error).toBe("Unable to save payout method");
  });

  it("still refuses an unapproved partner with the intended message", async () => {
    portal.getApprovedPartnerByAuthUserId.mockResolvedValue(null);
    const { POST } = await import("./payout-method/route");
    const res = await POST(request("paypal", "me@example.com"));

    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("Partner account not approved yet");
  });
});

describe("PUT /api/partner/referral-code", () => {
  const request = (code: string) =>
    new Request("http://localhost/api/partner/referral-code", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

  it("keeps the ambassador-facing refusal intact", async () => {
    portal.changeOwnReferralCode.mockRejectedValue(new Error("Only approved ambassadors can set a referral code."));
    const { PUT } = await import("./referral-code/route");
    const body = await json(await PUT(request("NEWCODE")));

    expect(body.error).toBe("Only approved ambassadors can set a referral code.");
  });

  it("keeps 'That code is already taken.'", async () => {
    portal.changeOwnReferralCode.mockRejectedValue(new Error("That code is already taken."));
    const { PUT } = await import("./referral-code/route");
    const body = await json(await PUT(request("TAKEN1")));

    expect(body.error).toBe("That code is already taken.");
  });

  it("replaces a database failure with Vanta's words", async () => {
    portal.changeOwnReferralCode.mockRejectedValue(
      new Error('[Supabase] referral code change failed\nduplicate key value violates unique constraint "ambassadors_referral_code_key"'),
    );
    const { PUT } = await import("./referral-code/route");
    const body = await json(await PUT(request("NEWCODE")));

    expect(body.error).toBe("Unable to update your referral code.");
    expect(body.error).not.toMatch(/supabase|constraint/i);
  });
});
