import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE REAPER'S DECISIONS.
//
// The DATABASE property this exists for — that a claim stranded at 'sending'
// holds email_send_log_automation_once for ever, and that 'failed' is what
// lifts it — is proved against a real Postgres in
// sql/marketing-frequency-guard.test.ts. This suite proves the judgement made
// on top of it, which is the part with a wrong answer available:
//
//   release a slot whose message NEVER went out  → the sequence resumes.
//   release a slot whose message DID go out      → the customer gets a second
//                                                  win-back and, because a
//                                                  gift-bearing automation
//                                                  mints a fresh token on every
//                                                  render, a second gift.
//
// marketing.ts ranks those plainly: "a missed marketing email costs nothing
// next to a duplicate one". So the interesting assertions here are the ones
// about NOT releasing.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  sends: [] as Row[],
  events: [] as Row[],
  /** Make the delivery-event read fail, to pin the fail-closed direction. */
  eventsError: null as { message: string } | null,
  /** Make the stranded-row read fail. */
  sendsError: null as { message: string } | null,
  /** Every write the reaper issued, so an unfiltered UPDATE cannot hide. */
  updates: [] as Array<{ patch: Row; filters: Array<[string, unknown]> }>,
  alerts: [] as Row[],
}));

/** A PostgREST-shaped builder over two arrays. Thenable, like the real one. */
function builder(table: string) {
  let rows: Row[] = table === "email_send_log" ? [...db.sends] : [...db.events];
  let mode: "select" | "update" = "select";
  let patch: Row = {};
  const filters: Array<[string, unknown]> = [];
  const api: Record<string, unknown> = {
    select: () => api,
    update: (next: Row) => { mode = "update"; patch = next; return api; },
    eq: (col: string, value: unknown) => {
      filters.push([col, value]);
      rows = rows.filter((row) => row[col] === value);
      return api;
    },
    lt: (col: string, value: string) => {
      rows = rows.filter((row) => String(row[col]) < value);
      return api;
    },
    gte: (col: string, value: string) => {
      rows = rows.filter((row) => String(row[col]) >= value);
      return api;
    },
    in: (col: string, values: unknown[]) => {
      rows = rows.filter((row) => values.includes(row[col]));
      return api;
    },
    order: () => api,
    limit: (n: number) => { rows = rows.slice(0, n); return api; },
    then: (resolve: (value: { data: Row[] | null; error: unknown }) => unknown) => {
      if (table === "email_send_log" && mode === "select" && db.sendsError) {
        return resolve({ data: null, error: db.sendsError });
      }
      if (table === "email_delivery_events" && db.eventsError) {
        return resolve({ data: null, error: db.eventsError });
      }
      if (mode === "update") {
        db.updates.push({ patch, filters: [...filters] });
        for (const row of rows) {
          const live = db.sends.find((candidate) => candidate.id === row.id);
          if (live) Object.assign(live, patch);
        }
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: rows, error: null });
    },
  };
  return api;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { from: (table: string) => builder(table) },
}));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: Row) => { db.alerts.push(alert); },
}));

const { reapStrandedMarketingSends, MARKETING_STRANDED_AFTER_MINUTES } =
  await import("@/lib/email/marketing-send-reaper");

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function stranded(overrides: Partial<Row> = {}): Row {
  return {
    id: String(overrides.id ?? "log-1"),
    campaign_type: "automation:winback_60",
    reference_id: "lapsed@example.test:1",
    recipient_email: "lapsed@example.test",
    sent_at: ago(60),
    status: "sending",
    ...overrides,
  };
}

beforeEach(() => {
  db.sends = [];
  db.events = [];
  db.eventsError = null;
  db.sendsError = null;
  db.updates = [];
  db.alerts = [];
});

describe("what the reaper releases", () => {
  it("releases a claim with no delivery evidence, so the sequence resumes", async () => {
    db.sends = [stranded()];
    const result = await reapStrandedMarketingSends();
    expect(result).toMatchObject({ stranded: 1, released: 1, confirmed: 0, undecided: 0 });
    expect(db.sends[0].status).toBe("failed");
  });

  it("releases one whose only event says the provider REFUSED it", async () => {
    db.sends = [stranded()];
    db.events = [{ recipient_email: "lapsed@example.test", kind: "failed", received_at: ago(59) }];
    expect((await reapStrandedMarketingSends()).released).toBe(1);
    expect(db.sends[0].status).toBe("failed");
  });

  it("leaves a claim younger than the window alone — it may still be in flight", async () => {
    db.sends = [stranded({ sent_at: ago(MARKETING_STRANDED_AFTER_MINUTES - 5) })];
    expect(await reapStrandedMarketingSends()).toMatchObject({ stranded: 0, released: 0 });
    expect(db.sends[0].status).toBe("sending");
  });
});

describe("what the reaper refuses to release", () => {
  it("closes a delivered message as SENT, keeping the slot held", async () => {
    // The expensive mistake, and the reason this module reads the event log at
    // all: the crash happened AFTER the provider accepted. Releasing here would
    // mail a second win-back carrying a second gift token.
    db.sends = [stranded()];
    db.events = [{ recipient_email: "lapsed@example.test", kind: "delivered", received_at: ago(59) }];
    const result = await reapStrandedMarketingSends();
    expect(result).toMatchObject({ released: 0, confirmed: 1 });
    expect(db.sends[0].status).toBe("sent");
  });

  it("treats an open or a click as proof it went out", async () => {
    for (const kind of ["opened", "clicked", "hard_bounce", "complaint"]) {
      db.sends = [stranded({ id: `log-${kind}` })];
      db.events = [{ recipient_email: "lapsed@example.test", kind, received_at: ago(59) }];
      db.updates = [];
      expect((await reapStrandedMarketingSends()).confirmed, kind).toBe(1);
    }
  });

  it("ignores an event too far from the send to be this message's", async () => {
    // A different message to the same address a week later proves nothing about
    // this one, and crediting it would hold a slot that should be freed.
    db.sends = [stranded()];
    db.events = [{ recipient_email: "lapsed@example.test", kind: "delivered", received_at: ago(60 - 9 * 24 * 60) }];
    expect((await reapStrandedMarketingSends()).released).toBe(1);
  });

  it("decides NOTHING when the evidence cannot be read", async () => {
    // Fail closed. One more tick of a blocked slot costs a delayed marketing
    // email; guessing costs a duplicate one. The next tick asks again.
    db.sends = [stranded()];
    db.eventsError = { message: "connection reset" };
    const result = await reapStrandedMarketingSends();
    expect(result).toMatchObject({ stranded: 1, released: 0, confirmed: 0, undecided: 1 });
    expect(db.sends[0].status).toBe("sending");
    expect(db.updates).toHaveLength(0);
  });

  it("does nothing at all when the send log cannot be read", async () => {
    db.sends = [stranded()];
    db.sendsError = { message: "schema cache" };
    expect(await reapStrandedMarketingSends()).toMatchObject({ stranded: 0, released: 0, undecided: 0 });
    expect(db.updates).toHaveLength(0);
  });
});

describe("how it writes", () => {
  it("writes one row at a time, pinned by id AND by the status it read", async () => {
    // Compare-and-set: if the original invocation finished between the read and
    // this write, it owns the outcome. An update filtered by anything less
    // would let a reaper overwrite a real send's own record.
    db.sends = [stranded()];
    await reapStrandedMarketingSends();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toEqual([["id", "log-1"], ["status", "sending"]]);
  });

  it("asks for the delivery events ONCE for the whole batch", async () => {
    db.sends = [stranded({ id: "a" }), stranded({ id: "b", recipient_email: "other@example.test" })];
    const result = await reapStrandedMarketingSends();
    expect(result.stranded).toBe(2);
    expect(result.released).toBe(2);
  });

  it("judges each address on its own evidence, not the batch's", async () => {
    db.sends = [
      stranded({ id: "a" }),
      stranded({ id: "b", recipient_email: "other@example.test", reference_id: "other@example.test:1" }),
    ];
    db.events = [{ recipient_email: "other@example.test", kind: "delivered", received_at: ago(59) }];
    const result = await reapStrandedMarketingSends();
    expect(result).toMatchObject({ released: 1, confirmed: 1 });
    expect(db.sends.find((row) => row.id === "a")?.status).toBe("failed");
    expect(db.sends.find((row) => row.id === "b")?.status).toBe("sent");
  });
});

describe("what it tells the operator", () => {
  it("raises a CRITICAL when an automation slot was the thing blocked", async () => {
    // That is the case that never heals on its own, and the one where a
    // customer was silently unreachable until this moment.
    db.sends = [stranded()];
    await reapStrandedMarketingSends();
    expect(db.alerts[0]).toMatchObject({ type: "marketing_send_stranded", severity: "critical" });
  });

  it("raises only a warning for a slot that was not permanently blocking", async () => {
    db.sends = [stranded({ campaign_type: "cart_recovery_t24h", reference_id: "cart-1" })];
    await reapStrandedMarketingSends();
    expect(db.alerts[0]).toMatchObject({ severity: "warning" });
  });

  it("says nothing when there was nothing to say", async () => {
    await reapStrandedMarketingSends();
    expect(db.alerts).toHaveLength(0);
  });
});
