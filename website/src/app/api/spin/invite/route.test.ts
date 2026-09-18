import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ONE QUESTION THE INVITATION CARD IS ALLOWED TO ASK.
//
// Everything that would make an interruption wrong is decided here rather than
// in the browser: the wheel being off, a spin already taken, a number already
// on the list, no session at all. These pin each of those, and pin that the
// reply carries no credential — the page signs its own token, and a spin link
// in a JSON body is a spin link in a log.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  wheelEnabled: true,
  campaignId: "winback_2026q4",
  cooldownDays: 7,
  sessionEmail: null as string | null,
  existingSpin: null as unknown,
  standing: "none" as "none" | "subscribed" | "opted_out",
  throwOnRead: false,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-control", () => ({
  getSpinWheelConfig: async () => ({ enabled: state.wheelEnabled, campaignId: state.campaignId }),
  getSmsSignupConfig: async () => ({ promptsEnabled: true, dismissCooldownDays: state.cooldownDays, holdoutPercent: 0 }),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => (state.sessionEmail ? { id: "u1", email: state.sessionEmail } : null),
}));

vi.mock("@/lib/sms-consent", () => ({ readSmsStanding: async () => state.standing }));

vi.mock("@/lib/spin/spin-service", () => ({
  readExistingSpin: async () => {
    if (state.throwOnRead) throw new Error("database blip");
    return state.existingSpin;
  },
}));

const { GET } = await import("./route");

const ask = async () => (await GET()).json();

beforeEach(() => {
  state.wheelEnabled = true;
  state.cooldownDays = 7;
  state.sessionEmail = "shopper@example.test";
  state.existingSpin = null;
  state.standing = "none";
  state.throwOnRead = false;
});

describe("when the card may open", () => {
  it("invites a signed-in shopper who has not spun", async () => {
    const body = await ask();
    expect(body.mayInvite).toBe(true);
    expect(body.alreadySpun).toBe(false);
    expect(body.accountEmail).toBe("shopper@example.test");
    expect(body.dismissCooldownDays).toBe(7);
  });

  it("carries the operator's cooldown rather than a number of its own", async () => {
    state.cooldownDays = 30;
    expect((await ask()).dismissCooldownDays).toBe(30);
  });
});

describe("when it must stay silent", () => {
  it("says nothing to a visitor with no session", async () => {
    state.sessionEmail = null;
    const body = await ask();
    expect(body.mayInvite).toBe(false);
    expect(body.accountEmail).toBeNull();
  });

  it("says nothing while the wheel is switched off", async () => {
    // /spin is a 404 in that state, so an invitation would point at nothing.
    state.wheelEnabled = false;
    expect((await ask()).mayInvite).toBe(false);
  });

  it("does not invite somebody to do a thing they have already done", async () => {
    state.existingSpin = { prize: { id: "glp_2" } };
    const body = await ask();
    expect(body.mayInvite).toBe(false);
    expect(body.alreadySpun).toBe(true);
  });

  it("stays silent rather than promising a wheel a blip may have taken away", async () => {
    state.throwOnRead = true;
    expect((await ask()).mayInvite).toBe(false);
  });
});

describe("the text list is a separate question", () => {
  it("is asked of somebody who has never given a number", async () => {
    expect((await ask()).askForTexts).toBe(true);
  });

  it("is not asked of somebody already on the list", async () => {
    state.standing = "subscribed";
    const body = await ask();
    expect(body.askForTexts).toBe(false);
    // And the spin is still offered: the two never depend on one another.
    expect(body.mayInvite).toBe(true);
  });

  it("is not asked of somebody who once said stop", async () => {
    state.standing = "opted_out";
    const body = await ask();
    expect(body.askForTexts).toBe(false);
    expect(body.mayInvite).toBe(true);
  });
});

describe("what the reply may never contain", () => {
  it("hands back no spin token", async () => {
    const body = await ask();
    expect(JSON.stringify(body)).not.toMatch(/v1\./);
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("spinHref");
  });
});
