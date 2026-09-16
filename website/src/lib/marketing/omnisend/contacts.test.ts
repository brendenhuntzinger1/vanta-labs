import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// FAIL CLOSED MEANS DO NOT PUSH.
//
// collectContactFacts used to answer an unreadable email_suppressions read
// with { status: "unsubscribed", changedAt: now }, and every caller sent it.
// Omnisend keeps the status with the newest statusChangedAt, so one
// transient refusal unsubscribed the contact for good, and the next
// write-back mirrored that into the store as a suppression. Now an unknown
// suppression read yields NO facts at all: every caller already treats null
// as "skip this address", and nothing about the person is guessed.
// ---------------------------------------------------------------------------

type Table = {
  select?: (columns: string) => unknown;
};

const reads: Record<string, { data: unknown; error: { message: string } | null } | (() => never)> = {};

function table(name: string): Table {
  const answer = () => {
    const read = reads[name] ?? { data: null, error: null };
    if (typeof read === "function") return read();
    return read;
  };
  const chain = {
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: async () => answer(),
    maybeSingle: async () => answer(),
  };
  return { select: () => chain };
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { from: (name: string) => table(name) },
}));
vi.mock("@/lib/auth-confirmation-email", () => ({ findUserByEmail: async () => null }));
vi.mock("@/lib/email/recipient-attestation", () => ({ recipientHasAttested: async () => false }));

const requests: unknown[] = [];
vi.mock("@/lib/marketing/omnisend/client", () => ({
  omnisendActive: () => ({ active: true, reason: null }),
  omnisendRequest: async (request: unknown) => {
    requests.push(request);
    return { ok: true, status: 200, body: {}, error: null };
  },
}));

const ADDRESS = "quiet.person@example.test";

beforeEach(() => {
  for (const key of Object.keys(reads)) delete reads[key];
  requests.length = 0;
  vi.restoreAllMocks();
});

describe("collectContactFacts when the suppression read is not known", () => {
  it("returns null on a refused read, rather than facts that say unsubscribed", async () => {
    reads.email_suppressions = { data: null, error: { message: "permission denied" } };
    const { collectContactFacts } = await import("@/lib/marketing/omnisend/contacts");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await collectContactFacts(ADDRESS)).toBeNull();
    // Logged under the module prefix, and never with the address.
    const lines = error.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.some((line) => line.startsWith("[omnisend/contacts]") && /suppression/.test(line))).toBe(true);
    for (const line of lines) expect(line).not.toContain(ADDRESS);
  });

  it("returns null when the read throws", async () => {
    reads.email_suppressions = () => { throw new Error("socket hang up"); };
    const { collectContactFacts } = await import("@/lib/marketing/omnisend/contacts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await collectContactFacts(ADDRESS)).toBeNull();
  });

  it("still derives facts when the read answers, empty or not", async () => {
    const { collectContactFacts } = await import("@/lib/marketing/omnisend/contacts");
    reads.email_suppressions = { data: null, error: null };
    const known = await collectContactFacts(ADDRESS);
    expect(known?.emailConsent.status).toBe("nonSubscribed");

    reads.email_suppressions = { data: { email: ADDRESS, reason: "unsubscribed", created_at: "2026-09-01T00:00:00.000Z" }, error: null };
    const gone = await collectContactFacts(ADDRESS);
    expect(gone?.emailConsent).toEqual({ status: "unsubscribed", changedAt: "2026-09-01T00:00:00.000Z" });
  });
});

describe("upsertOmnisendContact when the suppression read is not known", () => {
  it("posts nothing and answers false", async () => {
    reads.email_suppressions = { data: null, error: { message: "permission denied" } };
    const { upsertOmnisendContact } = await import("@/lib/marketing/omnisend/contacts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await upsertOmnisendContact(ADDRESS)).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("posts the contact when the read answers", async () => {
    reads.email_suppressions = { data: null, error: null };
    const { upsertOmnisendContact } = await import("@/lib/marketing/omnisend/contacts");
    expect(await upsertOmnisendContact(ADDRESS)).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SMS CONSENT FROM THE ADDRESS'S OWN ROW.
//
// sms_subscribers (sms-subscribers.sql) carries the box ticked on the sign-up
// page or at the checkout, guest or not. With no account row to say otherwise
// it is the consent; an account row that carries a decision wins over it.
// ---------------------------------------------------------------------------

type Posted = { body: { identifiers: Array<{ type: string; id: string; channels?: { sms?: { status: string; statusChangedAt: string } } }> } };

describe("collectContactFacts reads sms_subscribers after the account row", () => {
  beforeEach(() => {
    reads.email_suppressions = { data: null, error: null };
  });

  it("a ticked checkout box with a number is SMS consent, dated when it was ticked, from where it was ticked", async () => {
    reads.sms_subscribers = { data: { phone: "(512) 555-0100", source: "checkout", consented_at: "2026-09-10T15:00:00.000Z", opted_out_at: null }, error: null };
    const { collectContactFacts, upsertOmnisendContact } = await import("@/lib/marketing/omnisend/contacts");
    const facts = await collectContactFacts(ADDRESS);
    expect(facts?.smsConsent).toEqual({ status: "subscribed", changedAt: "2026-09-10T15:00:00.000Z", source: "checkout" });
    expect(facts?.phone).toBe("(512) 555-0100");
    await upsertOmnisendContact(ADDRESS);
    const phone = (requests[0] as Posted).body.identifiers.find((identifier) => identifier.type === "phone");
    expect(phone?.id).toBe("+15125550100");
    expect(phone?.channels?.sms).toEqual({ status: "subscribed", statusChangedAt: "2026-09-10T15:00:00.000Z" });
  });

  it("a stopped row is an opt-out, dated when they said stop", async () => {
    reads.sms_subscribers = { data: { phone: "(512) 555-0100", source: "signup", consented_at: "2026-09-10T15:00:00.000Z", opted_out_at: "2026-09-12T09:00:00.000Z" }, error: null };
    const { collectContactFacts } = await import("@/lib/marketing/omnisend/contacts");
    const facts = await collectContactFacts(ADDRESS);
    expect(facts?.smsConsent).toEqual({ status: "unsubscribed", changedAt: "2026-09-12T09:00:00.000Z" });
  });

  it("no row, or a row that cannot be read, is no SMS consent at all", async () => {
    const { collectContactFacts } = await import("@/lib/marketing/omnisend/contacts");
    expect((await collectContactFacts(ADDRESS))?.smsConsent).toBeNull();
    reads.sms_subscribers = { data: null, error: { message: "relation does not exist" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await collectContactFacts(ADDRESS))?.smsConsent).toBeNull();
  });
});
