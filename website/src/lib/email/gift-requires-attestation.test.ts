import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B (INTERIM). NEVER PROMISE A GIFT THAT CANNOT BE SPENT.
//
// The storefront is default-deny: /cart and /checkout require an account or a
// grant, because the 21+ and research-use representations are collected on the
// sign-in form and this is an age-gated catalogue. attachEmailLinkGrant mints a
// marketing-link grant ONLY for an address that has already made both, and
// fails closed on everything else.
//
// selectAutomationTargets keys on customer_email, not on an account id, so a
// lapsed GUEST is a legitimate win-back target. The result, verified in
// production on 2026-09-12: three of twelve paid customers have no auth account
// at all and forty of a hundred and fifty-two accounts carry no attestation.
// Each of those, on a gift-bearing automation, received a real minted token,
// clicked it, and reached "Sign in to continue" for an account they do not
// have — holding a gift they could not use.
//
// The rule under test is about the PROMISE, not the gate. Vanta withholds the
// message. It does not weaken, bypass or pre-fill the attestation, and it
// grants nothing. Messages that carry no offer are untouched, because a
// reminder that costs nothing still reaches everybody.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/email/automations");

const state = {
  /** Addresses whose auth account carries BOTH representations. */
  attested: new Set<string>(),
  /** Every RPC the partition makes — one per DISTINCT address, not per target. */
  asked: [] as string[],
  /** Set to make the lookup fail, to pin the fail-closed direction. */
  rpcError: null as { message: string } | null,
  /** Any write attempted through the client. Must stay empty: this is a read. */
  writes: [] as string[],
};

vi.mock("server-only", () => ({}));
// The REAL partitionByAttestation calls the REAL recipientHasAttested — they
// live in one module, so mocking the export would not intercept the internal
// call and the test would prove nothing. Mock the RPC underneath instead, which
// also means these assertions cover the attestation read itself.
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "auth_user_attested_by_email") throw new Error(`unexpected rpc ${fn}`);
      const email = String(args.p_email ?? "");
      state.asked.push(email);
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.attested.has(email.trim().toLowerCase()), error: null };
    },
    from: (table: string) => {
      state.writes.push(table);
      throw new Error(`partitionByAttestation must not touch ${table}`);
    },
  },
}));
vi.mock("@/lib/log-redaction", () => ({ redactEmailForLog: (e: string) => e }));

import { partitionByAttestation } from "@/lib/email/recipient-attestation";

beforeEach(() => {
  state.attested = new Set(["member@example.test"]);
  state.asked = []; state.rpcError = null; state.writes = [];
});

describe("partitionByAttestation", () => {
  it("separates addresses that can redeem from addresses that cannot", async () => {
    const { attested, unattested } = await partitionByAttestation([
      "member@example.test",
      "guest@example.test",
    ]);
    expect(attested.has("member@example.test")).toBe(true);
    expect(unattested.has("guest@example.test")).toBe(true);
  });

  it("normalises case and whitespace, so one address is one lookup", async () => {
    await partitionByAttestation(["  MEMBER@Example.Test  ", "member@example.test"]);
    expect(state.asked).toHaveLength(1);
  });

  it("ignores blanks rather than asking about them", async () => {
    const { attested, unattested } = await partitionByAttestation(["", "   ", null as never]);
    expect(attested.size).toBe(0);
    expect(unattested.size).toBe(0);
    expect(state.asked).toHaveLength(0);
  });

  it("treats an unreadable lookup as NOT attested — the cheaper mistake", async () => {
    // recipientHasAttested already fails closed. What matters here is that the
    // caller inherits that: withholding a message the next sweep reconsiders
    // costs less than spending a real token on a journey that dead-ends.
    state.rpcError = { message: "connection reset" };
    const { unattested } = await partitionByAttestation(["anyone@example.test"]);
    expect(unattested.has("anyone@example.test")).toBe(true);
  });

  it("does not attest, grant or mutate anything while deciding", async () => {
    // The whole point: this is a read. If it ever starts writing, the gate has
    // been moved rather than respected.
    await partitionByAttestation(["guest@example.test"]);
    expect(state.writes).toHaveLength(0);
  });
});
