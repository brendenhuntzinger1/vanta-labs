import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// /api/unsubscribe mirrors the opt-out onto the account's marketing toggle.
//
// It found the account with auth.admin.listUsers({ perPage: 1000 }) and a scan,
// so for any customer past the thousandth the toggle in /account/settings
// silently stayed ON after they had unsubscribed. The lookup now goes through
// findUserByEmail, which asks the directory for THIS address.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  listUsersCalls: 0,
  user: { id: "user-1042", email: "late@example.test" } as { id: string; email: string } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/unsubscribe", () => ({ verifyUnsubscribeToken: () => true }));
vi.mock("@/lib/auth-confirmation-email", () => ({
  findUserByEmail: vi.fn(async (email: string) =>
    state.user && state.user.email === email.toLowerCase() ? state.user : null),
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>) => {
        state.upserts.push({ table, row });
        return { error: null };
      },
    }),
    auth: {
      admin: {
        listUsers: async () => {
          state.listUsersCalls += 1;
          return { data: { users: [] }, error: null };
        },
      },
    },
  },
}));

const { NextRequest } = await import("next/server");

beforeEach(() => {
  state.upserts = [];
  state.listUsersCalls = 0;
  state.user = { id: "user-1042", email: "late@example.test" };
});

describe("the account preference mirror", () => {
  it("finds the account by address rather than scanning the first thousand users", async () => {
    // Driven through POST: since EMAIL-07 the GET only renders the confirmation
    // page and changes nothing (see route.test.ts); the opt-out — and with it
    // the preference mirror — happens on the POST the page's button makes.
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/api/unsubscribe?email=Late%40example.test&token=t", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(state.listUsersCalls).toBe(0);
    const pref = state.upserts.find((u) => u.table === "customer_preferences");
    expect(pref?.row).toMatchObject({ user_id: "user-1042", marketing_emails: false });
  });

  it("still records the suppression when there is no account for the address", async () => {
    state.user = null;
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/api/unsubscribe?email=guest%40example.test&token=t", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(state.upserts.map((u) => u.table)).toEqual(["email_suppressions"]);
  });
});
