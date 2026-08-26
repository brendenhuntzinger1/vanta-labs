import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// F-A-19 — A SHORT READ MUST NOT BECOME A SEND.
//
// The audience builder read three lists through `readAllRows`, which stopped as
// soon as a page came back shorter than its page size. That is sound only while
// Supabase's `max-rows` is exactly that page size — a project API setting this
// application cannot observe. Set it lower and every page arrives short, the
// loop stops on the first one, and an arbitrarily large table is read as one
// page with no error.
//
// Two of those lists decide who GETS mail. The third decides who must NOT:
//
//   "a truncated suppression list does not fail, it just stops mentioning some
//    of the people who unsubscribed — and the next campaign mails them."
//
// That is the one outcome this system is not free to absorb, so a truncated read
// now refuses the send instead of quietly delivering it.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => ({
  /** The server's per-response cap. Below the reader's page size on purpose. */
  maxRowsPerResponse: 1_000_000,
  preferences: [] as Array<{ user_id: string }>,
  subscribers: [] as Array<{ email: string }>,
  suppressions: [] as Array<{ email: string }>,
  /** A ceiling low enough to force `truncated` without seeding a million rows. */
  authUsers: [] as Array<{ id: string; email: string }>,
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
      range: (from: number, to: number) => {
        const want = to - from + 1;
        const size = Math.min(want, store.maxRowsPerResponse);
        return Promise.resolve({ data: rows().slice(from, from + size), error: null });
      },
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
      auth: {
        admin: {
          listUsers: async () => ({ data: { users: store.authUsers }, error: null }),
        },
      },
    },
  };
});

const { loadConsentedAudience } = await import("@/lib/email/audience");

function people(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.test` }));
}

beforeEach(() => {
  store.maxRowsPerResponse = 1_000_000;
  store.preferences = [];
  store.subscribers = people(10, "sub");
  store.suppressions = [];
  store.authUsers = [];
});

describe("the audience is built from complete lists, or not at all", () => {
  it("builds normally when every list is read whole", async () => {
    store.suppressions = [{ email: "sub3@example.test" }];

    const audience = await loadConsentedAudience();

    expect(audience.subscribers.size).toBe(9);
    expect(audience.all.has("sub3@example.test")).toBe(false);
  });

  it("subtracts suppressions from the audience", async () => {
    store.suppressions = [{ email: "SUB1@EXAMPLE.TEST" }, { email: "sub2@example.test" }];

    const audience = await loadConsentedAudience();

    // Case-insensitively, or an unsubscribe is defeated by capitalisation.
    expect(audience.all.has("sub1@example.test")).toBe(false);
    expect(audience.all.has("sub2@example.test")).toBe(false);
    expect(audience.all.size).toBe(8);
  });

  /**
   * THE DEFECT, AND THE FIX.
   *
   * A server cap BELOW the reader's page size makes every page arrive short. The
   * old reader treated the first short page as the end of the table and returned
   * 400 of 5,000 suppressions — so 4,600 people who had unsubscribed stayed in
   * the audience and got the next campaign.
   *
   * The bounded reader advances by the rows it actually received, so a low cap
   * costs round trips instead of coverage. Every suppression is subtracted.
   */
  it("subtracts EVERY suppression even when the server caps each response short", async () => {
    store.subscribers = people(5000, "sub");
    store.suppressions = people(5000, "sub");   // the same 5,000 people
    store.maxRowsPerResponse = 400;

    const audience = await loadConsentedAudience();

    // Nobody survives: every subscriber is on the suppression list.
    expect(audience.all.size).toBe(0);
  });

  it("reads the whole subscriber list under the same cap", async () => {
    store.subscribers = people(2500, "sub");
    store.maxRowsPerResponse = 400;

    const audience = await loadConsentedAudience();

    // The old reader returned 400 here.
    expect(audience.subscribers.size).toBe(2500);
  });

  it("is unaffected when the cap is simply the page size", async () => {
    store.subscribers = people(2500, "sub");
    store.suppressions = people(1200, "gone");
    store.maxRowsPerResponse = 1000;

    const audience = await loadConsentedAudience();

    expect(audience.subscribers.size).toBe(2500);
    expect(audience.all.size).toBe(2500);
  });
});

/**
 * The ceiling half, proven separately.
 *
 * A cap below the page size does not truncate — that is the point of the bounded
 * reader, and the cases above prove it. Truncation only happens at the
 * APPLICATION ceiling, which is half a million rows; seeding that many here
 * would test the fake, not the code. So the wiring is proven directly: when the
 * pager reports truncation, the audience builder must refuse rather than return
 * a partial list. The pager's own truncation reporting is proven in
 * supabase-page-bounded.test.ts.
 */
describe("a pager that reports truncation stops the send", () => {
  /**
   * Each guard is exercised on its own. A single mock that truncates everything
   * would trip the FIRST guard and leave the other two untested — which it did:
   * removing either of the later guards changed no result until this was
   * parameterised.
   */
  const READS = [
    ["marketing opt-in read", "the account opt-in list"],
    ["marketing subscriber read", "the subscriber list"],
    ["suppression list read", "the suppression list — people who unsubscribed"],
  ] as const;

  for (const [label, what] of READS) {
    it(`refuses when ${what} came back truncated`, async () => {
      vi.resetModules();
      vi.doMock("@/lib/supabase-page", () => ({
        readAllRowsBounded: async (
          _page: unknown,
          options: { label?: string },
        ) => ({
          rows: [] as Array<{ email: string; user_id: string }>,
          truncated: options.label === label,
        }),
      }));

      const { loadConsentedAudience: guarded } = await import("@/lib/email/audience");
      await expect(guarded()).rejects.toThrow(/refused rather than sent/i);

      vi.doUnmock("@/lib/supabase-page");
      vi.resetModules();
    });
  }

  /** NEGATIVE CONTROL: no truncation anywhere must not refuse. */
  it("does not refuse when every read is complete", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase-page", () => ({
      readAllRowsBounded: async () => ({ rows: [], truncated: false }),
    }));

    const { loadConsentedAudience: guarded } = await import("@/lib/email/audience");
    await expect(guarded()).resolves.toBeTruthy();

    vi.doUnmock("@/lib/supabase-page");
    vi.resetModules();
  });
});
