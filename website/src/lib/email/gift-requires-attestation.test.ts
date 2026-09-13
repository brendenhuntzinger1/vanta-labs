import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// NEVER PROMISE A GIFT THAT CANNOT BE SPENT.
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
//
// NARROWED once the attestation step shipped. An unattested recipient WITH an
// account is no longer stranded — /attest collects the statements, writes them
// to that account and mints the grant — so withholding from those forty
// accounts was costing real win-backs. An address with NO account is routed
// into sign-up instead, a longer journey the harness does not yet drive through
// to a completed purchase, so it stays withheld until it does.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/email/automations");

const state = {
  /** Addresses whose auth account carries BOTH representations. */
  attested: new Set<string>(),
  /** Addresses that have an auth account at all, attested or not. */
  accounts: new Set<string>(),
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
      const email = String(args.p_email ?? "");
      state.asked.push(`${fn}:${email}`);
      if (state.rpcError) return { data: null, error: state.rpcError };
      const normalised = email.trim().toLowerCase();
      if (fn === "auth_user_attested_by_email") return { data: state.attested.has(normalised), error: null };
      if (fn === "auth_user_id_by_email") {
        return { data: state.accounts.has(normalised) ? `id-${normalised}` : null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
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
  // The unattested-but-registered case: an account exists, so /attest can write
  // the representations to it and the gift is spendable.
  state.accounts = new Set(["member@example.test", "registered@example.test"]);
  state.asked = []; state.rpcError = null; state.writes = [];
});

describe("partitionByAttestation", () => {
  it("separates addresses that can redeem from addresses that cannot", async () => {
    const { reachable, unreachable } = await partitionByAttestation([
      "member@example.test",
      "guest@example.test",
    ]);
    expect(reachable.has("member@example.test")).toBe(true);
    expect(unreachable.has("guest@example.test")).toBe(true);
  });

  it("REACHES an unattested address that has an account — /attest serves it now", async () => {
    // The narrowing. This recipient lands on the interstitial, makes the two
    // statements, and the representations are written to their own auth record.
    // Withholding from them was costing a win-back for no protection.
    const { reachable, unreachable } = await partitionByAttestation(["registered@example.test"]);
    expect(reachable.has("registered@example.test")).toBe(true);
    expect(unreachable.size).toBe(0);
  });

  it("still withholds from an address with NO account anywhere", async () => {
    // Sign-up is where their representations would be recorded, and that longer
    // journey is not yet proven end to end. Until it is, the promise is not made.
    const { unreachable } = await partitionByAttestation(["nobody@example.test"]);
    expect(unreachable.has("nobody@example.test")).toBe(true);
  });

  it("does not pay for the account lookup when the address is already attested", async () => {
    await partitionByAttestation(["member@example.test"]);
    expect(state.asked).toEqual(["auth_user_attested_by_email:member@example.test"]);
  });

  it("normalises case and whitespace, so one address is one lookup", async () => {
    await partitionByAttestation(["  MEMBER@Example.Test  ", "member@example.test"]);
    expect(state.asked).toHaveLength(1);
  });

  it("ignores blanks rather than asking about them", async () => {
    const { reachable, unreachable } = await partitionByAttestation(["", "   ", null as never]);
    expect(reachable.size).toBe(0);
    expect(unreachable.size).toBe(0);
    expect(state.asked).toHaveLength(0);
  });

  it("treats an unreadable lookup as UNREACHABLE — the cheaper mistake", async () => {
    // Both lookups fail closed. What matters here is that the caller inherits
    // that: withholding a message the next sweep reconsiders costs less than
    // spending a real token on a journey that dead-ends.
    state.rpcError = { message: "connection reset" };
    const { unreachable } = await partitionByAttestation(["anyone@example.test"]);
    expect(unreachable.has("anyone@example.test")).toBe(true);
  });

  it("does not attest, grant or mutate anything while deciding", async () => {
    // The whole point: this is a read. If it ever starts writing, the gate has
    // been moved rather than respected.
    await partitionByAttestation(["guest@example.test"]);
    expect(state.writes).toHaveLength(0);
  });
});
