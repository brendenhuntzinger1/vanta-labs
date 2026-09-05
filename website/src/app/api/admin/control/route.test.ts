import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE CONTROL ENDPOINT AND THE TWO CREDENTIALS THAT LIVE IN IT.
//
// The Pushover token and user key are configured from the Control Center,
// which means they travel through this endpoint. Anyone holding the pair can
// push whatever they like to the owner's phone, so the rule the email settings
// already follow applies here: set or not set, never the value.
//
// The second half matters as much as the first. A panel that cannot READ a
// credential cannot send it back either, so an empty field has to mean
// "unchanged" — otherwise every save would quietly wipe the token that makes
// order notifications work.
// ---------------------------------------------------------------------------

const session = { username: "owner", role: "super_admin" };
let currentSession: typeof session | null = session;

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => currentSession,
  getRequestIpAddress: () => "127.0.0.1",
  getRequestUserAgent: () => "vitest",
}));
vi.mock("@/lib/admin-roles", () => ({ canManageSettings: (role: string) => role === "super_admin" }));

const stored: Record<string, Record<string, unknown>> = {};
const writes: Array<{ section: string; key: string; value: unknown }> = [];

vi.mock("@/lib/admin-control", () => ({
  MAX_CARD_FEE_PERCENT: 10,
  getControlSnapshot: async (section?: string) =>
    section ? { [section]: stored[section] ?? {} } : JSON.parse(JSON.stringify(stored)),
  getReferralProgramConfig: async () => ({
    personalDiscountPercent: 10, discountPercent: 10, defaultCommissionPercent: 20,
  }),
  upsertControlValue: async (input: { section: string; key: string; value: unknown }) => {
    writes.push({ section: input.section, key: input.key, value: input.value });
    (stored[input.section] ??= {})[input.key] = input.value;
  },
}));

const { GET, PATCH } = await import("./route");

const get = () => GET(new Request("https://vantalabsresearch.com/api/admin/control"));
const patch = (updates: unknown[]) =>
  PATCH(new Request("https://vantalabsresearch.com/api/admin/control", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  }));

beforeEach(() => {
  currentSession = session;
  writes.length = 0;
  for (const key of Object.keys(stored)) delete stored[key];
  stored.notifications = {
    pushover_token: "SECRET-TOKEN-VALUE",
    pushover_user_key: "SECRET-USER-VALUE",
    order_push_webhook_url: "https://hooks.example.com/catch/1/abc",
  };
  stored.alerts = { email: "owner@example.com" };
});

describe("reading the settings", () => {
  it("never sends the Pushover credentials to the browser", async () => {
    const body = await (await get()).text();
    expect(body).not.toContain("SECRET-TOKEN-VALUE");
    expect(body).not.toContain("SECRET-USER-VALUE");
  });

  it("says they are stored, so the panel can show it", async () => {
    const body = await (await get()).json() as { secretsSet: Record<string, boolean> };
    expect(body.secretsSet["notifications.pushover_token"]).toBe(true);
    expect(body.secretsSet["notifications.pushover_user_key"]).toBe(true);
  });

  it("still returns the ordinary settings beside them", async () => {
    const body = await (await get()).json() as { snapshot: Record<string, Record<string, unknown>> };
    expect(body.snapshot.notifications.order_push_webhook_url).toBe("https://hooks.example.com/catch/1/abc");
    expect(body.snapshot.alerts.email).toBe("owner@example.com");
  });

  it("refuses a caller with no admin session", async () => {
    currentSession = null;
    expect((await get()).status).toBe(401);
  });
});

describe("saving the settings", () => {
  it("writes a credential the operator actually typed", async () => {
    const response = await patch([{ section: "notifications", key: "pushover_token", value: "brand-new-token" }]);
    expect(response.status).toBe(200);
    expect(writes).toContainEqual({ section: "notifications", key: "pushover_token", value: "brand-new-token" });
  });

  it("treats a blank credential as unchanged rather than as a wipe", async () => {
    // The panel cannot read the stored token, so a blank field is the normal
    // state of an untouched form — not an instruction to delete it.
    await patch([{ section: "notifications", key: "pushover_token", value: "" }]);
    expect(writes).toEqual([]);
    expect(stored.notifications.pushover_token).toBe("SECRET-TOKEN-VALUE");
  });

  it("does not let a blank credential take the rest of the save down with it", async () => {
    // Before the filter ran ahead of the blanking backstop, an empty secret in
    // the payload was a "destructive clear" and 409'd the whole request — so
    // editing the alert email could fail because of a field nobody touched.
    const response = await patch([
      { section: "notifications", key: "pushover_token", value: "" },
      { section: "alerts", key: "email", value: "new@example.com" },
    ]);
    expect(response.status).toBe(200);
    expect(writes).toEqual([{ section: "alerts", key: "email", value: "new@example.com" }]);
  });

  it("clears a credential when the operator says so out loud", async () => {
    await patch([{ section: "notifications", key: "pushover_token", value: "", allowClear: true }]);
    expect(writes).toContainEqual({ section: "notifications", key: "pushover_token", value: "" });
  });

  it("refuses a role that cannot manage settings", async () => {
    currentSession = { username: "staff", role: "support" };
    expect((await patch([{ section: "alerts", key: "email", value: "x@example.com" }])).status).toBe(403);
  });
});

// ADM-08. A card fee of 50% is a typo, and until now it saved with "Changes are
// live on checkout." and surcharged every card order by half.
describe("the card processing fee has a ceiling", () => {
  it("refuses a percentage above the ceiling before writing anything", async () => {
    const before = writes.length;
    const response = await patch([{ section: "payment_methods", key: "card_processing_fee", value: { enabled: true, percentage: 50, label: "Card fee", noticeText: "" } }]);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/between 0 and 10/);
    expect(writes.length).toBe(before);
  });

  it("refuses a negative or unparseable percentage the same way", async () => {
    for (const percentage of [-1, "abc"]) {
      const response = await patch([{ section: "payment_methods", key: "card_processing_fee", value: { enabled: true, percentage } }]);
      expect(response.status, String(percentage)).toBe(400);
    }
  });

  it("accepts a sane percentage", async () => {
    const response = await patch([{ section: "payment_methods", key: "card_processing_fee", value: { enabled: true, percentage: 3, label: "Card fee", noticeText: "" } }]);
    expect(response.status).toBe(200);
    expect(writes.at(-1)).toMatchObject({ section: "payment_methods", key: "card_processing_fee" });
  });
});
