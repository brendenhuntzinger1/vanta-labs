import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE WINNER WHO CAME FROM THEIR INBOX AND NEVER SIGNED IN.
//
// The whole live journey is anonymous: 104 spin links were mailed, the wheel is
// reachable on an email-link grant, and the grant is deliberately a bare
// capability that carries no address (email/link-grant.ts says so in as many
// words). So for a recipient who has not signed in, the session is empty.
//
// Four of the sixteen wedges are laddered, and the picker renders from the
// prize, not from the session — so a quarter of anonymous winners are shown a
// size chooser. Every press of it answered 401, and the message they were shown
// was the wall's, not the route's: "Sign in to continue", on a page reached
// from a link that had just proved who they were.
//
// THE SIGNED LINK IS THE IDENTITY, and the mint path beside it already says
// why: "The address in the token is trustworthy — this server signed it".
// Choosing a size moves nothing but that address's own prize.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  campaignId: "winback_2026q4",
  sessionEmail: null as string | null,
  chooseCalls: [] as Array<{ verifiedEmail: string; campaignId: string; label: string }>,
  outcome: { ok: true, label: "10mg", minSubtotalCents: 10_500 } as unknown,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-control", () => ({
  getSpinWheelConfig: async () => ({ enabled: true, campaignId: state.campaignId }),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "u1", email: state.sessionEmail } : null),
}));

vi.mock("@/lib/spin/spin-dose", () => ({
  chooseSpinDose: async (input: { verifiedEmail: string; campaignId: string; label: string }) => {
    state.chooseCalls.push(input);
    return state.outcome;
  },
}));

const { POST } = await import("./route");
const { signSpinToken } = await import("@/lib/spin/spin-token");

function post(body: unknown) {
  return POST(new Request("https://vantalabs.test/api/spin/dose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  state.sessionEmail = null;
  state.chooseCalls = [];
  state.outcome = { ok: true, label: "10mg", minSubtotalCents: 10_500 };
  process.env.UNSUBSCRIBE_SECRET = "test-secret-for-spin-links";
});

describe("who the route will take a size choice from", () => {
  it("takes the session's address when there is one", async () => {
    state.sessionEmail = "winner@example.test";
    const response = await post({ label: "10mg" });
    expect(response.status).toBe(200);
    expect(state.chooseCalls[0].verifiedEmail).toBe("winner@example.test");
  });

  it("takes the signed spin link's address when there is no session", async () => {
    const token = await signSpinToken("mailed@example.test", state.campaignId);
    const response = await post({ label: "10mg", token });
    expect(response.status).toBe(200);
    expect(state.chooseCalls[0].verifiedEmail).toBe("mailed@example.test");
  });

  it("refuses a link signed for a previous campaign", async () => {
    // Genuine, and useless: honouring it would move a prize in a promotion the
    // holder was never mailed.
    const token = await signSpinToken("mailed@example.test", "winback_2026q3");
    const response = await post({ label: "10mg", token });
    expect(response.status).toBe(401);
    expect(state.chooseCalls).toHaveLength(0);
  });

  it("refuses a forged link", async () => {
    const response = await post({ label: "10mg", token: "v1.aaaa.bbbb.99999999999999.0123456789abcdef0123456789abcdef" });
    expect(response.status).toBe(401);
    expect(state.chooseCalls).toHaveLength(0);
  });

  it("refuses when the session and the link name different people", async () => {
    // A forwarded link. Moving the token holder's dose under a signed-in
    // stranger's session is the one thing neither identity authorises.
    state.sessionEmail = "someone.else@example.test";
    const token = await signSpinToken("mailed@example.test", state.campaignId);
    const response = await post({ label: "10mg", token });
    expect(response.status).toBe(409);
    expect(state.chooseCalls).toHaveLength(0);
  });

  it("still refuses a caller with neither", async () => {
    const response = await post({ label: "10mg" });
    expect(response.status).toBe(401);
    expect(state.chooseCalls).toHaveLength(0);
  });
});

describe("the wall has to let the request reach the route", () => {
  it("names the dose route on the email-link grant's allowlist", async () => {
    // Without this the wall answers first and the customer is shown "Sign in to
    // continue" — the wall's words, for a link that had already proved who they
    // were. The route verifies its own credential, which is the same footing
    // /api/spin and /api/spin/claim are listed on.
    const { emailGrantAllowsPath } = await import("@/lib/email/link-grant");
    expect(emailGrantAllowsPath("/api/spin/dose")).toBe(true);
  });
});
