import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// TWO SWEEPS, ONE EMAIL.
//
// runAutomations() deduped by reading every already-sent reference_id
// (loadAlreadySent), choosing the targets not in that set, then sending and
// logging. A read, then a write, with nothing between them — so two overlapping
// sweeps both read "not sent" for the same reference and both mail the
// customer. Nothing prevented it; it had not happened yet.
//
// This drives the real send loop with a fake email_send_log that enforces the
// same partial unique index production now has
// (email_send_log_automation_once), and runs two sweeps whose reads BOTH happen
// before either write — the interleaving that used to double-send.
//
// The assertion is the number of MESSAGES, not the number of log rows. A guard
// that records correctly and mails twice is the defect.
// ---------------------------------------------------------------------------

type LogRow = {
  campaign_type: string;
  reference_id: string | null;
  recipient_email: string;
  template_key: string;
  status: string;
  sent_at: string;
};

const db = {
  log: [] as LogRow[],
  /** Every message actually handed to the provider. */
  delivered: [] as { to: string; campaignType: string; referenceId?: string }[],
  suppressed: new Set<string>(),
  /** Set true to hold every read at the same snapshot, forcing the race. */
  freezeReadsAt: null as LogRow[] | null,
};

/** The partial unique index, in JS: (campaign_type, reference_id) where status <> 'failed'. */
function violatesUnique(row: LogRow) {
  if (!row.campaign_type.startsWith("automation:")) return false;
  if (row.reference_id === null) return false;
  if (row.status === "failed") return false;
  return db.log.some((existing) =>
    existing.campaign_type === row.campaign_type
    && existing.reference_id === row.reference_id
    && existing.status !== "failed");
}

vi.mock("@/lib/supabase-server", () => {
  const table = (name: string) => {
    const filters: Record<string, string> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: string) => { filters[col] = val; return builder; },
      neq: () => builder,
      order: () => builder,
      maybeSingle: async () => {
        if (name === "email_suppressions") {
          return { data: db.suppressed.has(filters.email) ? { email: filters.email } : null, error: null };
        }
        return { data: null, error: null };
      },
      range: async () => {
        if (name === "email_send_log") {
          const rows = db.freezeReadsAt ?? db.log;
          return {
            data: rows.filter((r) => r.campaign_type === filters.campaign_type && r.status !== "failed"),
            error: null,
          };
        }
        if (name === "email_automations") return { data: [], error: null };
        return { data: [], error: null };
      },
      insert: async (row: LogRow) => {
        if (name !== "email_send_log") return { error: null };
        if (violatesUnique(row)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        db.log.push(row);
        return { error: null };
      },
      // CHAINED, NOT IMMEDIATE. supabase-js is `.update(patch).eq().eq().eq()`,
      // so a mock whose update() runs straight away sees an empty filter set and
      // matches nothing — which is a bug in the mock that looks exactly like the
      // product failing to record an outcome.
      update: (patch: Partial<LogRow>) => {
        const chain: Record<string, unknown> = {
          eq: (col: string, val: string) => { filters[col] = val; return chain; },
          then: (resolve: (v: unknown) => void) => {
            for (const row of db.log) {
              if (row.campaign_type === filters.campaign_type
                && row.reference_id === filters.reference_id
                && row.status === filters.status) {
                Object.assign(row, patch);
              }
            }
            resolve({ error: null });
          },
        };
        return chain;
      },
    };
    // delete() is chained as .delete().eq().eq().eq(); resolve on await.
    builder.delete = () => {
      const chain: Record<string, unknown> = {
        eq: (col: string, val: string) => { filters[col] = val; return chain; },
        then: (resolve: (v: unknown) => void) => {
          db.log = db.log.filter((row) => !(
            row.campaign_type === filters.campaign_type
            && row.reference_id === filters.reference_id
            && row.status === filters.status));
          resolve({ error: null });
        },
      };
      return chain;
    };
    return builder;
  };
  return { supabaseAdmin: { from: (name: string) => table(name) } };
});

vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: async (input: { to: string; campaignType: string; referenceId?: string }) => {
    if (db.suppressed.has(input.to)) {
      return { success: false, suppressed: true, error: "unsubscribed" };
    }
    db.delivered.push({ to: input.to, campaignType: input.campaignType, referenceId: input.referenceId });
    return { success: true };
  },
}));

const { claimAutomationSendForTest, closeAutomationSendForTest } =
  await import("@/lib/email/automations");

const CAMPAIGN = "automation:post_purchase";
const REFERENCE = "order-abc";
const EMAIL = "zane@example.com";

beforeEach(() => {
  db.log = [];
  db.delivered = [];
  db.suppressed = new Set();
  db.freezeReadsAt = null;
});

/** One sweep's worth of work for a single target, exactly as runAutomations does it. */
async function sweep() {
  if (!(await claimAutomationSendForTest(CAMPAIGN, REFERENCE, EMAIL, "automation_post_purchase"))) {
    return "skipped";
  }
  const { sendMarketingEmail } = await import("@/lib/email/marketing");
  const sent = await sendMarketingEmail({
    to: EMAIL, campaignType: CAMPAIGN, referenceId: REFERENCE,
    templateKey: "automation_post_purchase", subject: "s", html: "h", text: "t",
  } as never);
  await closeAutomationSendForTest(CAMPAIGN, REFERENCE, sent.success ? "sent" : "failed");
  return sent.success ? "sent" : "failed";
}

describe("an automation email cannot be sent twice", () => {
  it("THE RACE: two sweeps reading the same snapshot deliver ONE message", async () => {
    // Both sweeps start before either has written anything — the interleaving
    // that a read-then-write cannot survive.
    const [a, b] = await Promise.all([sweep(), sweep()]);

    expect(db.delivered).toHaveLength(1);
    expect([a, b].sort()).toEqual(["sent", "skipped"]);
  });

  it("ten concurrent sweeps still deliver exactly one", async () => {
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => sweep()));

    expect(db.delivered, "more than one customer email went out").toHaveLength(1);
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(9);
  });

  it("a later sweep does not re-send one already delivered", async () => {
    await sweep();
    const second = await sweep();

    expect(second).toBe("skipped");
    expect(db.delivered).toHaveLength(1);
  });

  it("a FAILED send stays eligible, so one provider hiccup is not permanent", async () => {
    // 'failed' sits outside the unique index on purpose. A recipient dropped
    // from the sequence by a transient error would never be recovered.
    await claimAutomationSendForTest(CAMPAIGN, REFERENCE, EMAIL, "automation_post_purchase");
    await closeAutomationSendForTest(CAMPAIGN, REFERENCE, "failed");

    const retry = await sweep();
    expect(retry).toBe("sent");
    expect(db.delivered).toHaveLength(1);
  });

  it("a claim is taken BEFORE the message goes out, not after", async () => {
    // The whole point. If the row were written after sending, the second sweep
    // would already have mailed by the time the first one recorded anything.
    await claimAutomationSendForTest(CAMPAIGN, REFERENCE, EMAIL, "automation_post_purchase");
    expect(db.log).toHaveLength(1);
    expect(db.log[0].status).toBe("sending");
    expect(db.delivered, "a message went out before the slot was claimed").toHaveLength(0);
  });

  it("an unsubscribed recipient releases the slot rather than holding it forever", async () => {
    db.suppressed.add(EMAIL);
    const outcome = await sweep();

    expect(outcome).toBe("failed");
    expect(db.delivered).toHaveLength(0);
  });

  it("a claim failure that is NOT a duplicate refuses to send", async () => {
    // An un-migrated database has no index; treating that as "go ahead" would
    // reopen the race everywhere at once. It must throw, not send.
    const broken = { code: "42P01", message: "relation does not exist" };
    const original = db.log;
    db.log = new Proxy([], {
      get(target, prop) {
        if (prop === "some") return () => { throw Object.assign(new Error(broken.message), broken); };
        return Reflect.get(target, prop);
      },
    }) as LogRow[];

    await expect(sweep()).rejects.toBeDefined();
    expect(db.delivered).toHaveLength(0);
    db.log = original;
  });
});
