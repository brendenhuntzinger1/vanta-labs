import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// RESOLVING OPTED-IN ACCOUNTS TO ADDRESSES.
//
// customer_preferences stores a user_id, not an address, so every audience
// build has to turn opted-in ids into emails. supabase-js's admin API offers
// listUsers() with paging and nothing else, so the builder paged the WHOLE auth
// directory and kept the rows that matched — O(every account that has ever
// signed up), paid on every campaign send and every audience preview, however
// few people are actually opted in.
//
// It also had a ceiling: 100 pages of 1,000. Past 100,000 accounts, an opted-in
// customer simply stopped being found, and the send went out to a short list
// with no error — the same silent-short-read failure audience-truncation.test.ts
// exists to prevent, one layer further in.
//
// auth-emails-by-user-ids.sql asks the direct question instead. This file pins
// three things: the fast path is used when the function is present, the old
// paging still works when it is not, and the paging ceiling can no longer drop
// somebody quietly.
// ---------------------------------------------------------------------------

const PER_PAGE = 1000;

const store = vi.hoisted(() => ({
  preferences: [] as Array<{ user_id: string }>,
  subscribers: [] as Array<{ email: string }>,
  suppressions: [] as Array<{ email: string }>,
  /** null = the SQL function is not applied, so the RPC errors like a missing function. */
  rpcRows: null as Array<{ id: string; email: string }> | null,
  /** Pages the admin directory hands back, in order. */
  authPages: [] as Array<Array<{ id: string; email: string }>>,
  listUsersCalls: 0,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const table = (rows: () => Array<Record<string, unknown>>) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      order: () => b,
      range: (from: number, to: number) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from: (name: string) => {
        if (name === "customer_preferences") return table(() => store.preferences);
        if (name === "marketing_subscribers") return table(() => store.subscribers);
        if (name === "email_suppressions") return table(() => store.suppressions);
        throw new Error(`unexpected table ${name}`);
      },
      rpc: async (name: string, args: unknown) => {
        store.rpcCalls.push({ name, args });
        if (store.rpcRows === null) {
          return { data: null, error: { message: `function public.${name} does not exist` } };
        }
        const ids = new Set(((args as { p_ids?: string[] })?.p_ids ?? []).map(String));
        return { data: store.rpcRows.filter((row) => ids.has(row.id)), error: null };
      },
      auth: {
        admin: {
          listUsers: async ({ page }: { page: number; perPage: number }) => {
            store.listUsersCalls += 1;
            return { data: { users: store.authPages[page - 1] ?? [] }, error: null };
          },
        },
      },
    },
  };
});

const { loadConsentedAudience } = await import("@/lib/email/audience");

/** A full page of accounts that will never match an opted-in id. */
function strangers(page: number) {
  return Array.from({ length: PER_PAGE }, (_, i) => ({
    id: `stranger-${page}-${i}`,
    email: `stranger${page}-${i}@example.test`,
  }));
}

beforeEach(() => {
  store.preferences = [];
  store.subscribers = [];
  store.suppressions = [];
  store.rpcRows = null;
  store.authPages = [];
  store.listUsersCalls = 0;
  store.rpcCalls = [];
});

describe("the fast path", () => {
  it("resolves opted-in accounts without paging the directory at all", async () => {
    store.preferences = [{ user_id: "u1" }, { user_id: "u2" }];
    store.rpcRows = [
      { id: "u1", email: "one@example.test" },
      { id: "u2", email: "TWO@example.test" },
    ];

    const audience = await loadConsentedAudience();

    expect(audience.accounts.has("one@example.test")).toBe(true);
    // Normalised, or a suppression written in lower case would miss it.
    expect(audience.accounts.has("two@example.test")).toBe(true);
    expect(store.listUsersCalls).toBe(0);
  });

  it("asks only for the ids it actually needs", async () => {
    store.preferences = [{ user_id: "u1" }];
    store.rpcRows = [
      { id: "u1", email: "one@example.test" },
      { id: "u9", email: "nine@example.test" },
    ];

    await loadConsentedAudience();

    expect(store.rpcCalls[0]?.args).toEqual({ p_ids: ["u1"] });
  });

  it("does not call the database at all when nobody is opted in", async () => {
    store.subscribers = [{ email: "sub@example.test" }];

    const audience = await loadConsentedAudience();

    expect(audience.accounts.size).toBe(0);
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.listUsersCalls).toBe(0);
  });
});

describe("degrading when the SQL function has not been applied", () => {
  it("falls back to paging the directory and still resolves everyone", async () => {
    store.preferences = [{ user_id: "u1" }];
    store.rpcRows = null; // function missing
    store.authPages = [[{ id: "u1", email: "one@example.test" }]];

    const audience = await loadConsentedAudience();

    expect(audience.accounts.has("one@example.test")).toBe(true);
    expect(store.listUsersCalls).toBeGreaterThan(0);
  });
});

describe("the paging ceiling can no longer drop somebody quietly", () => {
  /**
   * THE DEFECT.
   *
   * The loop ran `for (page = 1; page <= 100; page++)` and simply stopped. An
   * opted-in customer sitting past that ceiling was not found, was not
   * mentioned, and did not fail the build — the campaign just went out to a
   * list that was missing them. Refusing the send is the same call
   * audience-truncation.test.ts already makes for a short suppression read.
   */
  it("refuses the audience when the directory was still full at the ceiling", async () => {
    store.preferences = [{ user_id: "never-in-this-directory" }];
    store.rpcRows = null;
    // Every page comes back full, so the directory is never exhausted.
    store.authPages = Array.from({ length: 200 }, (_, i) => strangers(i + 1));

    await expect(loadConsentedAudience()).rejects.toThrow(/audience/i);
  });

  /**
   * The mirror case, which must NOT throw: a deleted account leaves an opted-in
   * row behind whose id resolves to nothing. The directory legitimately runs
   * out, so that is an absent user, not a truncated read.
   */
  it("accepts a short final page as the genuine end of the directory", async () => {
    store.preferences = [{ user_id: "u1" }, { user_id: "deleted-account" }];
    store.rpcRows = null;
    store.authPages = [[{ id: "u1", email: "one@example.test" }]];

    const audience = await loadConsentedAudience();

    expect(audience.accounts.has("one@example.test")).toBe(true);
    expect(audience.accounts.size).toBe(1);
  });
});
