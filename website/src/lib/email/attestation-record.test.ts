import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE REPRESENTATIONS GO ON THE AUTHORITATIVE RECORD, OR NOWHERE.
//
// There is exactly one place this store keeps "this person said they are 21+
// and that these are for research use": auth.users.raw_user_meta_data, holding
// age_confirmed_21 and research_use_only_agreed. Signup writes them; the OAuth
// session route writes them; auth_user_attested_by_email — the function every
// gate in the email system reads — asks that record and nothing else.
//
// So the three things this file pins are the three ways a second register gets
// created by accident: writing somewhere else, writing twice, or writing when
// the answer was not actually known.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type User = { id: string; user_metadata?: Record<string, unknown> | null } | null;

const state = vi.hoisted(() => ({
  user: null as User,
  /** Every updateUserById call. Must stay empty for an already-attested user. */
  updates: [] as Array<{ id: string; meta: Record<string, unknown> }>,
  updateError: null as { message: string } | null,
  lookupThrows: false,
  /** Any table touched through the PostgREST client. Must stay empty. */
  tables: [] as string[],
}));

vi.mock("@/lib/auth-confirmation-email", () => ({
  findUserByEmail: async () => {
    if (state.lookupThrows) throw new Error("directory unavailable");
    return state.user;
  },
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        updateUserById: async (id: string, patch: { user_metadata?: Record<string, unknown> }) => {
          state.updates.push({ id, meta: patch.user_metadata ?? {} });
          return { data: null, error: state.updateError };
        },
      },
    },
    from: (table: string) => {
      state.tables.push(table);
      throw new Error(`the attestation record must not touch ${table}`);
    },
  },
}));

const { recordAttestationForEmail } = await import("@/lib/email/attestation-record");

beforeEach(() => {
  state.user = { id: "user-1", user_metadata: { role: "customer" } };
  state.updates = [];
  state.updateError = null;
  state.lookupThrows = false;
  state.tables = [];
});

describe("recording an attestation", () => {
  it("writes the two representations onto the auth record and nowhere else", () => {
    return recordAttestationForEmail("lapsed@example.test").then((outcome) => {
      expect(outcome).toBe("recorded");
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].meta).toMatchObject({
        age_confirmed_21: true,
        research_use_only_agreed: true,
      });
      expect(state.tables).toHaveLength(0);
    });
  });

  it("stamps when and where it was made, so the record can be audited", async () => {
    await recordAttestationForEmail("lapsed@example.test");
    expect(state.updates[0].meta.attested_at).toBeTruthy();
    expect(state.updates[0].meta.attested_via).toBe("email_link_interstitial");
  });

  it("keeps the metadata that was already there", async () => {
    state.user = { id: "user-1", user_metadata: { role: "customer", first_name: "Sam" } };
    await recordAttestationForEmail("lapsed@example.test");
    expect(state.updates[0].meta).toMatchObject({ role: "customer", first_name: "Sam" });
  });

  it("normalises the address, so one person is one lookup", async () => {
    expect(await recordAttestationForEmail("  Lapsed@Example.TEST  ")).toBe("recorded");
  });
});

describe("what it refuses to do", () => {
  it("does not re-stamp an account that already carries both", async () => {
    // The rule /api/auth/session already states, for the reason it gives:
    // re-stamping would replace a real first-time representation with today's
    // date and destroy the only evidence of when it was actually made.
    state.user = { id: "user-1", user_metadata: { age_confirmed_21: true, research_use_only_agreed: true, attested_at: "2025-01-01T00:00:00.000Z" } };
    expect(await recordAttestationForEmail("member@example.test")).toBe("already");
    expect(state.updates).toHaveLength(0);
  });

  it("re-stamps an account carrying only ONE of the two — half is not attested", async () => {
    state.user = { id: "user-1", user_metadata: { age_confirmed_21: true } };
    expect(await recordAttestationForEmail("half@example.test")).toBe("recorded");
  });

  it("does not create an account for an address that has none", async () => {
    // Manufacturing an account to hold a consent record would be inventing a
    // customer to carry a consent, which is the opposite of what one is for.
    state.user = null;
    expect(await recordAttestationForEmail("guest@example.test")).toBe("no_account");
    expect(state.updates).toHaveLength(0);
  });

  it("reports a REFUSED write as failure, not as success", async () => {
    // admin.updateUserById catches every GoTrue non-2xx and hands it back as
    // { error }. A try/catch alone would report a refused write as a recorded
    // attestation, which is the one mistake this must never make.
    state.updateError = { message: "429 too many requests" };
    expect(await recordAttestationForEmail("lapsed@example.test")).toBe("failed");
  });

  it("reports an unreadable directory as failure rather than as no account", async () => {
    state.lookupThrows = true;
    expect(await recordAttestationForEmail("lapsed@example.test")).toBe("failed");
    expect(state.updates).toHaveLength(0);
  });

  it("refuses an empty address without asking anything", async () => {
    expect(await recordAttestationForEmail("")).toBe("failed");
    expect(state.updates).toHaveLength(0);
  });
});
