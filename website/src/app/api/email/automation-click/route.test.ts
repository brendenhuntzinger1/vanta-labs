import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// THE CLICK ROUTES HAD NO TEST THAT EVER RAN THEM.
//
// Everything around them was covered — the signature scheme, the URL shape, the
// UTM wiring (by grepping the source) — and none of it executes the handler. So
// the one question an operator actually asks of this route, "did the click land
// in the ledger", had never been answered by a test.
//
// It matters most here because every write in this route is best-effort by
// design: a tracking failure must never strand a customer, so the recording is
// wrapped in a catch that swallows whatever it finds. That is the right
// behaviour for the customer and it means a broken write is INVISIBLE — no
// error, no log line, a correct-looking redirect, and a report that reads zero
// for ever.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "test-secret-not-a-real-one";
});

const SITE = "https://vanta.test";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  /** email_send_log, keyed the way the route matches it. */
  sendLog: [] as Array<Record<string, unknown>>,
  automations: [] as Array<Record<string, unknown>>,
  automationClicks: [] as Array<Record<string, unknown>>,
  /** Set to make the click-detail insert fail the way a transport error does. */
  clickInsertThrows: null as Error | null,
}));

/**
 * A Supabase stand-in with just enough of the query builder for this route:
 * every method returns the builder, and the builder is awaited either directly
 * (insert, update) or through maybeSingle (the automation lookup).
 */
vi.mock("@/lib/supabase-server", () => {
  const builder = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let pending: { op: "insert" | "update" | "select"; values?: Row } = { op: "select" };

    const matches = (row: Row) => filters.every(([column, value]) => row[column] === value);

    const run = () => {
      if (pending.op === "insert") {
        if (table === "email_automation_clicks") {
          if (state.clickInsertThrows) throw state.clickInsertThrows;
          state.automationClicks.push({ ...(pending.values ?? {}) });
        }
        return { data: null, error: null };
      }
      if (pending.op === "update") {
        const rows = table === "email_send_log" ? state.sendLog : [];
        for (const row of rows) if (matches(row)) Object.assign(row, pending.values);
        return { data: null, error: null };
      }
      const source = table === "email_automations" ? state.automations : state.sendLog;
      return { data: source.filter(matches), error: null };
    };

    const self: Record<string, unknown> = {
      select: () => self,
      insert: (values: Row) => { pending = { op: "insert", values }; return self; },
      update: (values: Row) => { pending = { op: "update", values }; return self; },
      eq: (column: string, value: unknown) => { filters.push([column, value]); return self; },
      is: (column: string, value: unknown) => { filters.push([column, value]); return self; },
      maybeSingle: async () => {
        const result = run() as { data: Row[] | null; error: unknown };
        return { data: (result.data ?? [])[0] ?? null, error: result.error };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (error) {
          return Promise.resolve(reject(error));
        }
      },
    };
    return self;
  };

  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

vi.mock("@/lib/env", () => ({ getSiteUrl: () => SITE }));
vi.mock("@/lib/auth-session", () => ({ getAuthenticatedUser: async () => null }));
vi.mock("@/lib/email/recipient-attestation", () => ({
  emailLinkLanding: async (input: { destination: string }) => ({ destination: input.destination, grant: null }),
  setEmailLinkGrantCookie: () => {},
}));

const { GET } = await import("@/app/api/email/automation-click/route");
const { buildAutomationClickUrl } = await import("@/lib/email/automation-links");

const EMAIL = "buyer@example.test";
const KEY = "welcome_no_purchase";

const click = () => GET(new NextRequest(buildAutomationClickUrl(KEY, EMAIL, EMAIL)));

const sendLogRow = () => state.sendLog[0];

beforeEach(() => {
  state.clickInsertThrows = null;
  state.automationClicks = [];
  state.automations = [{ key: KEY, cta_path: "/products" }];
  state.sendLog = [{
    campaign_type: `automation:${KEY}`,
    reference_id: EMAIL,
    recipient_email: EMAIL,
    sent_at: "2026-09-11T18:50:37.280Z",
    opened_at: "2026-09-12T14:09:03.241Z",
    clicked_at: null,
  }];
});

describe("a click on a retention automation", () => {
  it("redirects to the automation's own destination", async () => {
    const response = await click();
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/products");
  });

  it("stamps clicked_at on the send-log row, which is what every report counts", async () => {
    await click();
    expect(sendLogRow().clicked_at).toEqual(expect.any(String));
  });

  it("records the click detail beside it", async () => {
    await click();
    expect(state.automationClicks).toHaveLength(1);
    expect(state.automationClicks[0]).toMatchObject({ automation_key: KEY, reference_id: EMAIL, email: EMAIL });
  });
});

describe("when the click-detail insert fails", () => {
  // A transport error against the detail table is a lost row in a diagnostic
  // log. It must not also cost the send log its record of the click: that row
  // is the one the cart-recovery panel, the lifecycle funnel and the automation
  // report all read, and a click missing from it is a click that never happened
  // as far as the business can see.
  //
  // The campaign click route has guarded these two writes separately since the
  // same failure was found there; its comment says so in as many words. This
  // route bundled all three writes into one try/catch, so the first failure
  // silently discarded the two that followed it.
  beforeEach(() => {
    state.clickInsertThrows = new Error("fetch failed");
  });

  it("still stamps clicked_at on the send-log row", async () => {
    await click();
    expect(sendLogRow().clicked_at).toEqual(expect.any(String));
  });

  it("still redirects the customer, which was never in question", async () => {
    const response = await click();
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/products");
  });
});
