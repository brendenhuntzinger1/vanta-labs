import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A 20% DISCOUNT HANDED OUT FOR TYPING SOMEBODY ELSE'S EMAIL ADDRESS.
//
// isApprovedAmbassadorCustomer matched "by account first, then by email — so it
// works whether they shop with their ambassador account or a customer account on
// the same email". The intent is right and the second half had no proof behind
// it: nothing established that the caller controlled the address it named.
//
// At guest checkout there is no account, so only the email branch runs, and
// quote-order.ts:661 hands it `input.customer.email` — whatever was typed into
// the form:
//
//     const isApprovedAmbassadorSelf =
//       await isApprovedAmbassadorCustomer(input.customerUserId, input.customer.email);
//
// So a shopper who knows an approved ambassador's address types it in and takes
// the ambassador's personal discount. Live and material at the time this was
// written: the default personal discount is 20%
// (admin-control-shared.ts:39) and the production project had nine approved
// ambassadors, whose addresses a referral programme tends to make public.
//
// THE FIX, AND WHY IT IS SHAPED THIS WAY. The email branch now runs only for a
// caller that produced an account id, and it uses THAT ACCOUNT'S OWN address
// rather than the one supplied. A guest reaches only the account branch, which
// without an id is a no-op.
//
// Using the account's address rather than merely requiring one keeps the two
// callers in step, which matters more than it looks: payment-service.ts (the
// authoritative charge) and /api/account/ambassador-discount (the preview) must
// agree or the "Altered total detected" guard fires on a legitimate order.
// Trusting a supplied address whenever an id happened to be present would let
// those two answer differently for a signed-in customer who typed a different
// delivery address — the preview granting the discount, the charge withholding
// it, and the customer meeting an error at the till.
// ---------------------------------------------------------------------------

type AmbassadorRow = { id: string; email: string; status: string; auth_user_id: string | null };

const state = {
  ambassadors: [] as AmbassadorRow[],
  /** auth.users, as the admin API sees it. */
  users: {} as Record<string, { email: string }>,
  /** Every ambassadors lookup this run made, so the query itself can be asserted. */
  queries: [] as Array<{ by: "auth_user_id" | "email"; value: string }>,
};

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "ambassadors") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        maybeSingle: async () => {
          const by = filters.auth_user_id ? "auth_user_id" : "email";
          state.queries.push({ by, value: filters[by] });
          const match = state.ambassadors.find((a) => {
            if (filters.status && a.status !== filters.status) return false;
            if (filters.auth_user_id) return a.auth_user_id === filters.auth_user_id;
            if (filters.email) return a.email === filters.email;
            return false;
          });
          return { data: match ?? null, error: null };
        },
      };
      return builder;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: state.users[id] ? { id, email: state.users[id].email } : null },
          error: null,
        }),
      },
    },
  },
}));

const { isApprovedAmbassadorCustomer } = await import("@/lib/ambassador-status");

const AMBASSADOR_EMAIL = "star@example.com";
const AMBASSADOR_USER = "auth-user-ambassador";
const STRANGER_USER = "auth-user-stranger";

beforeEach(() => {
  state.ambassadors = [
    { id: "amb-1", email: AMBASSADOR_EMAIL, status: "approved", auth_user_id: AMBASSADOR_USER },
  ];
  state.users = {
    [AMBASSADOR_USER]: { email: AMBASSADOR_EMAIL },
    [STRANGER_USER]: { email: "stranger@example.com" },
  };
  state.queries = [];
});

describe("who counts as an approved ambassador at checkout", () => {
  it("THE LEAK: a GUEST who types the ambassador's address is not one", async () => {
    // Exactly the quote-order guest call: no account id, an attacker-supplied
    // address. This returned true, and the order took 20% off.
    expect(await isApprovedAmbassadorCustomer(undefined, AMBASSADOR_EMAIL)).toBe(false);
  });

  it("and does not even look the address up, so it is not a membership oracle", async () => {
    // A guest who could probe "is this address an ambassador?" learns who the
    // ambassadors are, which is the half of the leak that survives the discount
    // being withheld.
    await isApprovedAmbassadorCustomer(undefined, AMBASSADOR_EMAIL);
    expect(state.queries).toEqual([]);
  });

  it("a SIGNED-IN stranger cannot claim it by naming the address either", async () => {
    // Having any account must not be enough — it is the account's OWN address
    // that counts, never the one typed into the order form.
    expect(await isApprovedAmbassadorCustomer(STRANGER_USER, AMBASSADOR_EMAIL)).toBe(false);
  });

  it("the ambassador still gets it through their ambassador account", async () => {
    expect(await isApprovedAmbassadorCustomer(AMBASSADOR_USER, AMBASSADOR_EMAIL)).toBe(true);
  });

  it("and still gets it on a SEPARATE customer account with the same address", async () => {
    // The documented case the email branch exists for: an ambassador row that is
    // not linked to the account they happen to be shopping with. It survives,
    // because the address is now taken from the account rather than the form.
    state.ambassadors = [
      { id: "amb-1", email: AMBASSADOR_EMAIL, status: "approved", auth_user_id: null },
    ];
    const customerAccount = "auth-user-customer";
    state.users[customerAccount] = { email: AMBASSADOR_EMAIL };

    expect(await isApprovedAmbassadorCustomer(customerAccount, "something.else@example.com")).toBe(true);
    // Proof it used the ACCOUNT's address, not the supplied one.
    expect(state.queries.some((q) => q.by === "email" && q.value === AMBASSADOR_EMAIL)).toBe(true);
    expect(state.queries.some((q) => q.value === "something.else@example.com")).toBe(false);
  });

  it("a revoked ambassador loses it immediately, by either route", async () => {
    state.ambassadors = [
      { id: "amb-1", email: AMBASSADOR_EMAIL, status: "removed", auth_user_id: AMBASSADOR_USER },
    ];
    expect(await isApprovedAmbassadorCustomer(AMBASSADOR_USER, AMBASSADOR_EMAIL)).toBe(false);
  });

  it("an account the auth store does not know does not fall back to the form", async () => {
    // A stale or forged id must fail closed rather than reopening the leak.
    expect(await isApprovedAmbassadorCustomer("auth-user-missing", AMBASSADOR_EMAIL)).toBe(false);
  });
});
