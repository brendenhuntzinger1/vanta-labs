import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE WHEEL HAS TWO DOORS NOW, AND ONLY ONE OF THEM IS AN INBOX.
//
// It was built as a win-back destination: the only way in was a token minted at
// click time for a recipient /api/email/click had already verified. As the
// store's acquisition offer it also has to open from a product page, where
// there is no email click to verify anybody — so a signed-in shopper's own
// address is signed here instead.
//
// What must NOT change is who can spin as whom. These pin that: the mailed link
// still wins when it is good, a forwarded one is still refused rather than
// guessed at, an anonymous visitor with no link still gets nothing, and the
// address this page signs is only ever the session's own.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  enabled: true,
  campaignId: "winback_2026q4",
  sessionEmail: null as string | null,
  readCalls: [] as Array<{ email: string; campaignId: string }>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-control", () => ({
  getSpinWheelConfig: async () => ({ enabled: state.enabled, campaignId: state.campaignId }),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "u1", email: state.sessionEmail } : null),
}));

vi.mock("@/lib/spin/spin-service", () => ({
  readExistingSpin: async (input: { email: string; campaignId: string }) => {
    state.readCalls.push(input);
    return null;
  },
}));

vi.mock("@/lib/spin/spin-dose", () => ({ availableDoseRungs: async () => [] }));

// Stand-ins, so the assertions can read which branch the page took and with
// what. Rendering is not the question here; identity is.
vi.mock("@/components/spin-wheel", () => ({ default: function SpinWheel() { return null; } }));
vi.mock("@/components/spin-wrong-account", () => ({ SpinWrongAccount: function SpinWrongAccount() { return null; } }));

const SpinPage = (await import("./page")).default;
const { signSpinToken, verifySpinToken } = await import("@/lib/spin/spin-token");

type Rendered = { type: { name?: string }; props: Record<string, unknown> };

async function open(t?: string): Promise<Rendered> {
  const element = await SpinPage({ searchParams: Promise.resolve(t ? { t } : {}) });
  return element as unknown as Rendered;
}

beforeEach(() => {
  state.enabled = true;
  state.sessionEmail = null;
  state.readCalls = [];
  process.env.UNSUBSCRIBE_SECRET = "test-secret-for-spin-links";
});

describe("the mailed link, which is the journey that already existed", () => {
  it("renders the wheel for the address it names", async () => {
    const token = await signSpinToken("mailed@example.test", state.campaignId);
    const rendered = await open(token!);
    expect(rendered.type.name).toBe("SpinWheel");
    expect(rendered.props.token).toBe(token);
    expect(state.readCalls[0].email).toBe("mailed@example.test");
  });

  it("wins over the session when the two agree", async () => {
    state.sessionEmail = "mailed@example.test";
    const token = await signSpinToken("mailed@example.test", state.campaignId);
    const rendered = await open(token!);
    expect(rendered.props.token).toBe(token);
  });

  it("is refused as a forwarded link when the session names somebody else", async () => {
    state.sessionEmail = "someone.else@example.test";
    const token = await signSpinToken("mailed@example.test", state.campaignId);
    const rendered = await open(token!);
    expect(rendered.type.name).toBe("SpinWrongAccount");
    expect(state.readCalls).toHaveLength(0);
  });
});

describe("the storefront door", () => {
  it("signs the session's own address when there is no link at all", async () => {
    state.sessionEmail = "shopper@example.test";
    const rendered = await open();
    expect(rendered.type.name).toBe("SpinWheel");
    expect(state.readCalls[0]).toEqual({ email: "shopper@example.test", campaignId: state.campaignId });

    // THE ONLY ADDRESS THIS BRANCH WILL EVER SIGN. A token minted here that
    // named anyone else would be a spin minted for a stranger.
    const minted = await verifySpinToken(String(rendered.props.token));
    expect(minted).toEqual({ email: "shopper@example.test", campaignId: state.campaignId });
  });

  it("replaces a link from a previous campaign rather than refusing the shopper", async () => {
    // Genuine and stale. The old campaign grants nothing, and the visitor is
    // signed in, so they get this campaign's wheel instead of a dead end.
    state.sessionEmail = "shopper@example.test";
    const stale = await signSpinToken("shopper@example.test", "winback_2026q3");
    const rendered = await open(stale!);
    expect(rendered.type.name).toBe("SpinWheel");
    const minted = await verifySpinToken(String(rendered.props.token));
    expect(minted?.campaignId).toBe(state.campaignId);
  });

  it("gives an anonymous visitor with no usable link nothing", async () => {
    const rendered = await open("v1.aaaa.bbbb.99999999999999.0123456789abcdef0123456789abcdef");
    expect(rendered.type.name).toBe("LinkProblem");
    expect(state.readCalls).toHaveLength(0);
  });

  it("gives an anonymous visitor with no link at all nothing", async () => {
    const rendered = await open();
    expect(rendered.type.name).toBe("LinkProblem");
    expect(state.readCalls).toHaveLength(0);
  });
});
