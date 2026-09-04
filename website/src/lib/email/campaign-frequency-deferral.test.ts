import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A CAMPAIGN RECIPIENT THE FREQUENCY GUARD DEFERS IS PARKED, NOT PUNISHED.
//
// sendMarketingEmail answers { deferred: true, retryAt } when another marketing
// message reached the address inside the window. The batch sender's response,
// pinned here through the REAL sendCampaignBatch against a fake that honours
// the same filters production does:
//
//   * the row goes back to 'pending' with deferred_until = retryAt, its claim
//     released, and NO attempt counted — being mailed by something else this
//     morning is not a failure;
//   * the campaign is not finished while that row waits, so it cannot close
//     'sent' with a recipient still owed the message;
//   * claimBatch's `or(deferred_until.is.null, deferred_until.lte.now)` keeps
//     the row out of every batch until the window opens, and takes it back the
//     moment it does;
//   * however many times it is deferred, attempts stays at zero, so a deferral
//     can never exhaust MAX_ATTEMPTS and land the recipient on 'failed'.
//
// Time is frozen with fake timers because claimBatch reads Date.now() for its
// filter; advancing the clock is what "the window opened" means to it.
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "campaign-frequency-deferral-test-secret";
});

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);
const ALICE = "alice@example.com";
const BOB = "bob@example.com";

type CampaignRow = Record<string, unknown> & { id: string; status: string };
type RecipientRow = Record<string, unknown> & { id: string; campaign_id: string; email: string; status: string };

const db = vi.hoisted(() => ({
  campaigns: [] as Array<Record<string, unknown> & { id: string; status: string }>,
  recipients: [] as Array<Record<string, unknown> & { id: string; campaign_id: string; email: string; status: string }>,
  nextId: 1,
  /** Addresses the guard is currently deferring, and when their window opens. */
  deferred: new Set<string>(),
  retryAt: 0,
  /** Every address sendMarketingEmail was asked to write to, in order. */
  attempts: [] as string[],
  delivered: [] as string[],
}));

function matches(row: Record<string, unknown>, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([op, col, value]) => {
    const actual = row[col];
    switch (op) {
      case "eq": return actual === value;
      case "in": return Array.isArray(value) && (value as unknown[]).includes(actual);
      case "lt": return actual !== null && actual !== undefined && String(actual) < String(value);
      case "gte": return Number(actual ?? 0) >= Number(value);
      case "is": return value === null ? actual === null || actual === undefined : actual === value;
      case "or": {
        // PostgREST's `or=(a.is.null,a.lte.X)` — the batch claim uses it to skip
        // recipients the frequency guard deferred until later.
        return String(value).split(",").some((clause) => {
          const [c, o, ...rest] = clause.split(".");
          const v = rest.join(".");
          const a = row[c];
          if (o === "is" && v === "null") return a === null || a === undefined;
          if (o === "lte") return a !== null && a !== undefined && String(a) <= v;
          if (o === "gte") return a !== null && a !== undefined && String(a) >= v;
          if (o === "eq") return String(a) === v;
          return false;
        });
      }
      default: return true;
    }
  });
}

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "update" | "upsert" = "select";
    let patch: Record<string, unknown> = {};
    let pending: Array<Record<string, unknown>> = [];
    let ignoreDuplicates = false;
    let wantsCount = false;
    let limit = Infinity;

    const rowsFor = () => (table === "email_campaigns" ? db.campaigns : db.recipients) as Array<Record<string, unknown>>;

    const run = () => {
      const all = rowsFor();
      if (op === "update") {
        const hit = all.filter((row) => matches(row, filters)).slice(0, limit);
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null, count: hit.length };
      }
      if (op === "upsert") {
        const inserted: Array<Record<string, unknown>> = [];
        for (const row of pending) {
          const clash = db.recipients.some((r) => r.campaign_id === row.campaign_id && r.email === row.email);
          if (clash) {
            if (ignoreDuplicates) continue;
            return { data: null, error: { code: "23505", message: "duplicate key" }, count: 0 };
          }
          const created = { id: `r${db.nextId++}`, attempts: 0, claimed_at: null, deferred_until: null, ...row } as unknown as RecipientRow;
          db.recipients.push(created);
          inserted.push(created);
        }
        return { data: inserted, error: null, count: inserted.length };
      }
      const hit = all.filter((row) => matches(row, filters)).slice(0, limit);
      return { data: wantsCount ? [] : hit.map((row) => ({ ...row })), error: null, count: hit.length };
    };

    const builder: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) wantsCount = true;
        return builder;
      },
      update: (value: Record<string, unknown>) => { op = "update"; patch = value; return builder; },
      upsert: (rows: Array<Record<string, unknown>>, opts?: { ignoreDuplicates?: boolean }) => {
        op = "upsert"; pending = rows; ignoreDuplicates = Boolean(opts?.ignoreDuplicates); return builder;
      },
      eq: (col: string, value: unknown) => { filters.push(["eq", col, value]); return builder; },
      in: (col: string, value: unknown) => { filters.push(["in", col, value]); return builder; },
      lt: (col: string, value: unknown) => { filters.push(["lt", col, value]); return builder; },
      gte: (col: string, value: unknown) => { filters.push(["gte", col, value]); return builder; },
      is: (col: string, value: unknown) => { filters.push(["is", col, value]); return builder; },
      or: (clauses: string) => { filters.push(["or", "", clauses]); return builder; },
      not: () => builder,
      order: () => builder,
      limit: (value: number) => { limit = value; return builder; },
      range: () => builder,
      maybeSingle: async () => { const r = run(); return { data: (r.data ?? [])[0] ?? null, error: r.error }; },
      single: async () => { const r = run(); return { data: (r.data ?? [])[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => ({ marketingPostalAddress: "Vanta Labs, 1 Example Way" }),
  marketingBlockedReason: () => null,
  resolveMarketingFrom: () => "Vanta Labs <news@mail.example.com>",
}));

vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vantalabsresearch.com" }));

vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: async (input: { to: string }) => {
    db.attempts.push(input.to);
    if (db.deferred.has(input.to)) {
      return {
        success: false,
        deferred: true,
        retryAt: db.retryAt,
        error: "Deferred: this address received a marketing email inside the last 24 hours.",
      };
    }
    db.delivered.push(input.to);
    return { success: true };
  },
  isMarketingSuppressed: async () => false,
  extractEmailAddress: (from: string) => from,
}));

vi.mock("@/lib/email/audience", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/audience")>();
  return { ...actual, resolveAudience: async () => [ALICE, BOB] };
});

const { queueCampaign, sendCampaignBatch, MAX_ATTEMPTS } = await import("@/lib/email/campaign-sender");

function seedCampaign(overrides: Partial<CampaignRow> = {}): string {
  const id = `c${db.nextId++}`;
  db.campaigns.push({
    id,
    name: "September update",
    subject: "Our sale is live",
    preview_text: null,
    headline: "Buy 2 Get 1 Free",
    body: "The sale is live.",
    promo_code: null,
    cta_label: "SHOP NOW",
    cta_path: "/products",
    segment: "all",
    segment_param: null,
    status: "draft",
    scheduled_at: null,
    audience_kind: "customer",
    affiliate_filter: null,
    affiliate_ids: [],
    link_buttons: null,
    recipient_count: 0,
    ...overrides,
  });
  return id;
}

const bobRow = () => db.recipients.find((r) => r.email === BOB)!;
const attemptsOn = (email: string) => db.attempts.filter((to) => to === email).length;

beforeEach(() => {
  db.campaigns = [];
  db.recipients = [];
  db.nextId = 1;
  db.deferred = new Set();
  db.retryAt = 0;
  db.attempts = [];
  db.delivered = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a recipient the frequency guard defers", () => {
  it("goes back to pending with deferred_until = retryAt, no attempt counted, and the campaign stays open", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    db.deferred.add(BOB);
    db.retryAt = T0 + 20 * HOUR;

    const result = await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    expect(result.deferred).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(db.delivered).toEqual([ALICE]);

    const bob = bobRow();
    expect(bob.status).toBe("pending");
    expect(bob.deferred_until).toBe(new Date(T0 + 20 * HOUR).toISOString());
    expect(bob.attempts).toBe(0);
    expect(bob.claimed_at).toBeNull();
    expect(String(bob.error)).toMatch(/deferred/);

    // Somebody is still owed the message, so the campaign is not finished.
    expect(result.remaining).toBe(1);
    expect(result.finished).toBe(false);
    expect(result.status).toBeNull();
    expect(db.campaigns[0].status).toBe("sending");
    expect(db.campaigns[0].completed_at).toBeUndefined();
  });

  it("is not re-claimed by another batch inside the same window", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    db.deferred.add(BOB);
    db.retryAt = T0 + 20 * HOUR;
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(attemptsOn(BOB)).toBe(1);

    // Same instant: claimBatch's `or` filter leaves the row alone.
    const again = await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(attemptsOn(BOB)).toBe(1);
    expect(again.deferred).toBe(0);
    expect(again.sent).toBe(0);
    expect(again.remaining).toBe(1);
    expect(again.finished).toBe(false);

    // One minute short of the window: still not touched.
    vi.setSystemTime(T0 + 20 * HOUR - 60_000);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(attemptsOn(BOB)).toBe(1);
    expect(bobRow().status).toBe("pending");
  });

  it("is re-claimed once now >= deferred_until, sent, and the campaign finishes", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    db.deferred.add(BOB);
    db.retryAt = T0 + 20 * HOUR;
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    // The window opens, and the guard now lets the message through.
    vi.setSystemTime(T0 + 20 * HOUR);
    db.deferred.clear();
    const result = await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    expect(attemptsOn(BOB)).toBe(2);
    expect(db.delivered).toEqual([ALICE, BOB]);
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.finished).toBe(true);
    expect(result.status).toBe("sent");

    const bob = bobRow();
    expect(bob.status).toBe("sent");
    expect(bob.attempts).toBe(1);
    expect(db.campaigns[0].status).toBe("sent");
  });

  it("never counts toward MAX_ATTEMPTS: three deferrals in a row leave the row pending, never failed", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    db.deferred.add(BOB);

    // Three windows, each opening after the last — enough deferrals that, had
    // they been counted as attempts, MAX_ATTEMPTS would have closed the row.
    expect(MAX_ATTEMPTS).toBe(3);
    for (let round = 0; round < 3; round++) {
      vi.setSystemTime(T0 + round * 20 * HOUR);
      db.retryAt = Date.now() + 20 * HOUR;
      const result = await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
      expect(result.deferred, `round ${round}`).toBe(1);
      expect(result.failed, `round ${round}`).toBe(0);
      const bob = bobRow();
      expect(bob.status, `round ${round}`).toBe("pending");
      expect(bob.attempts, `round ${round}`).toBe(0);
      expect(bob.deferred_until, `round ${round}`).toBe(new Date(Date.now() + 20 * HOUR).toISOString());
    }
    expect(attemptsOn(BOB)).toBe(3);
    expect(bobRow().status).not.toBe("failed");
    expect(db.campaigns[0].status).toBe("sending");

    // And the row is still live: once the guard relents, the message goes out.
    vi.setSystemTime(T0 + 3 * 20 * HOUR);
    db.deferred.clear();
    const finalRun = await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(finalRun.sent).toBe(1);
    expect(finalRun.finished).toBe(true);
    expect(bobRow().status).toBe("sent");
    expect(bobRow().attempts).toBe(1);
  });
});
