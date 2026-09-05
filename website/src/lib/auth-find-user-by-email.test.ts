import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-06 — findUserByEmail FINDS ANY ACCOUNT, NOT THE NEWEST THOUSAND.
//
// It paged listUsers 200 × 5 and answered null for any address older than the
// newest 1,000 accounts. /api/auth/signup then treated "user already
// registered" as a mint failure — a CRITICAL "no account exists" alert for an
// address that has one, and no email — and /api/auth/resend-confirmation did
// nothing for an old unconfirmed account, silently.
//
// The lookup now asks the database directly (sql/auth-user-by-email.sql) and
// fetches the user by id; where that function is not applied it walks the
// whole directory rather than a slice of it.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));

/** 1,500 accounts, newest first, exactly as listUsers orders them. */
const DIRECTORY = Array.from({ length: 1500 }, (_, i) => ({
  id: `user-${i}`,
  email: `person${i}@example.test`,
  email_confirmed_at: null,
  user_metadata: { full_name: `Person ${i}` },
}));
/** Older than the newest 1,000 — the account the old code could not see. */
const OLD_ACCOUNT = DIRECTORY[1400];

const calls = { rpc: 0, getUserById: 0, listUsers: 0 };
let rpcMode: "found" | "not_found" | "unavailable" = "found";

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => { throw new Error("no table access expected"); },
    rpc: async (name: string, args: { p_email: string }) => {
      calls.rpc += 1;
      expect(name).toBe("auth_user_id_by_email");
      if (rpcMode === "unavailable") return { data: null, error: { code: "PGRST202", message: "Could not find the function public.auth_user_id_by_email" } };
      const match = DIRECTORY.find((u) => u.email === args.p_email);
      return { data: rpcMode === "found" && match ? match.id : null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          calls.getUserById += 1;
          return { data: { user: DIRECTORY.find((u) => u.id === id) ?? null }, error: null };
        },
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          calls.listUsers += 1;
          return { data: { users: DIRECTORY.slice((page - 1) * perPage, page * perPage) }, error: null };
        },
      },
    },
  },
}));

beforeEach(() => {
  calls.rpc = 0;
  calls.getUserById = 0;
  calls.listUsers = 0;
  rpcMode = "found";
});

describe("findUserByEmail", () => {
  it("finds an account older than the newest 1,000 through the direct lookup, without paging", async () => {
    const { findUserByEmail } = await import("@/lib/auth-confirmation-email");

    const found = await findUserByEmail(OLD_ACCOUNT.email.toUpperCase());

    expect(found?.id).toBe(OLD_ACCOUNT.id);
    expect(calls.rpc).toBe(1);
    expect(calls.getUserById).toBe(1);
    expect(calls.listUsers).toBe(0);
  });

  it("answers null for an unknown address on the lookup's word alone", async () => {
    const { findUserByEmail } = await import("@/lib/auth-confirmation-email");
    rpcMode = "not_found";

    expect(await findUserByEmail("nobody@example.test")).toBeNull();
    expect(calls.listUsers).toBe(0);
  });

  it("walks the WHOLE directory when the lookup function is not applied, and still finds the old account", async () => {
    const { findUserByEmail } = await import("@/lib/auth-confirmation-email");
    rpcMode = "unavailable";

    const found = await findUserByEmail(OLD_ACCOUNT.email);

    expect(found?.id).toBe(OLD_ACCOUNT.id);
    expect(calls.listUsers).toBeGreaterThan(1);
  });

  it("reports a genuinely absent address as null after walking everything", async () => {
    const { findUserByEmail } = await import("@/lib/auth-confirmation-email");
    rpcMode = "unavailable";

    expect(await findUserByEmail("nobody@example.test")).toBeNull();
  });
});
