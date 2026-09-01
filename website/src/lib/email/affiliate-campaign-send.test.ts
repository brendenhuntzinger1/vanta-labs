import { beforeEach, describe, expect, it, vi } from "vitest";

// Campaign tracking links are HMAC-signed; without a secret the sender throws
// before it reaches anything this file is about.
process.env.UNSUBSCRIBE_SECRET = "test-signing-secret";

// ---------------------------------------------------------------------------
// THE SEND PATH, AGAINST A FAKE THAT ENFORCES THE REAL CONSTRAINTS.
//
// Two properties are worth this much scaffolding, and neither can be observed
// without modelling the database:
//
//   1. ONE AFFILIATE, ONE EMAIL — however many times Send is pressed, however
//      many sweeps overlap. The fake enforces the real
//      `unique (campaign_id, email)` index, so a duplicate insert fails here
//      exactly as it would in production.
//   2. EACH AFFILIATE GETS THEIR OWN COPY. Personalisation is per recipient, so
//      asserting on one rendered body proves nothing; the assertions compare two
//      recipients' messages against each other.
//
// The assertion is always the number and content of DELIVERED MESSAGES, never
// the number of queue rows. A queue that records perfectly and mails twice is
// the defect.
// ---------------------------------------------------------------------------

type CampaignRow = Record<string, unknown> & { id: string; status: string };
type RecipientRow = Record<string, unknown> & { id: string; campaign_id: string; email: string; status: string };

const db = {
  campaigns: [] as CampaignRow[],
  recipients: [] as RecipientRow[],
  delivered: [] as Array<{ to: string; campaignType: string; subject: string; html: string; text: string }>,
  suppressed: new Set<string>(),
  nextId: 1,
  /** Set to make the audience read fail, as a truncated or outage read would. */
  failAudience: false,
};

function matches(row: Record<string, unknown>, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([op, col, value]) => {
    const actual = row[col];
    switch (op) {
      case "eq": return actual === value;
      case "in": return Array.isArray(value) && (value as unknown[]).includes(actual);
      case "lt": return actual !== null && actual !== undefined && String(actual) < String(value);
      case "gte": return Number(actual ?? 0) >= Number(value);
      case "is": return value === null ? actual === null || actual === undefined : actual === value;
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
          // The real unique index on (campaign_id, email). THIS is what makes a
          // second Send unable to produce a second message.
          const clash = db.recipients.some((r) => r.campaign_id === row.campaign_id && r.email === row.email);
          if (clash) {
            if (ignoreDuplicates) continue;
            return { data: null, error: { code: "23505", message: "duplicate key" }, count: 0 };
          }
          const created = { id: `r${db.nextId++}`, attempts: 0, claimed_at: null, ...row } as unknown as RecipientRow;
          db.recipients.push(created);
          inserted.push(created);
        }
        return { data: inserted, error: null, count: inserted.length };
      }
      const hit = all.filter((row) => matches(row, filters)).slice(0, limit);
      // COPIES, like a real result set. Returning live references would let the
      // code under test read a value it mutated a moment earlier and make a
      // genuine ordering bug invisible.
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
  sendMarketingEmail: async (input: { to: string; campaignType: string; subject: string; html: string; text: string }) => {
    if (db.suppressed.has(input.to)) return { success: false, suppressed: true, error: "unsubscribed" };
    db.delivered.push({ to: input.to, campaignType: input.campaignType, subject: input.subject, html: input.html, text: input.text });
    return { success: true };
  },
  isMarketingSuppressed: async (to: string) => db.suppressed.has(to),
  extractEmailAddress: (from: string) => from,
}));

const AFFILIATES = [
  { id: "amb-1", email: "jordan@example.com", first_name: "Jordan", referral_code: "JORDAN10", commission_percent: 15, status: "approved", disabled_at: null },
  { id: "amb-2", email: "sam@example.com", first_name: "Sam", referral_code: "SAM20", commission_percent: 20, status: "approved", disabled_at: null },
];

vi.mock("@/lib/email/affiliate-audience", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/affiliate-audience")>();
  return {
    ...actual,
    resolveAffiliateAudience: async (input: { filter: string; ambassadorIds?: string[] | null }) => {
      if (db.failAudience) throw new Error("suppression list read failed");
      return actual.selectAffiliateRecipients({
        rows: AFFILIATES,
        suppressed: db.suppressed,
        filter: input.filter as "all_active" | "selected",
        ambassadorIds: input.ambassadorIds ?? [],
        siteUrl: "https://vantalabsresearch.com",
      });
    },
  };
});

vi.mock("@/lib/email/audience", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/audience")>();
  return { ...actual, resolveAudience: async () => ["customer@example.com"] };
});

const { queueCampaign, sendCampaignBatch, CampaignAlreadyStartedError } = await import("@/lib/email/campaign-sender");

function seedCampaign(overrides: Partial<CampaignRow> = {}): string {
  const id = `c${db.nextId++}`;
  db.campaigns.push({
    id,
    name: "Affiliate update",
    subject: "{{first_name}}, the sale is live",
    preview_text: null,
    headline: "Buy 2 Get 1 Free",
    body: "Hey {{first_name}},\n\nYour code {{referral_code}} earns {{commission_percent}}%.\nShare {{referral_link}}",
    promo_code: null,
    cta_label: "SHOP NOW",
    cta_path: "/products",
    segment: "all",
    segment_param: null,
    status: "draft",
    scheduled_at: null,
    audience_kind: "affiliate",
    affiliate_filter: "all_active",
    affiliate_ids: [],
    link_buttons: null,
    recipient_count: 0,
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  db.campaigns = [];
  db.recipients = [];
  db.delivered = [];
  db.suppressed = new Set();
  db.nextId = 1;
  db.failAudience = false;
});

describe("queueing an affiliate campaign", () => {
  it("writes one queue row per active affiliate, each with its own merge context", async () => {
    const id = seedCampaign();
    const result = await queueCampaign(id);

    expect(result.queued).toBe(2);
    expect(db.recipients.map((r) => r.email).sort()).toEqual(["jordan@example.com", "sam@example.com"]);
    const jordan = db.recipients.find((r) => r.email === "jordan@example.com");
    expect(jordan?.ambassador_id).toBe("amb-1");
    expect(jordan?.merge_context).toMatchObject({ firstName: "Jordan", referralCode: "JORDAN10", commissionPercent: 15 });
  });

  it("records the audience size the owner was shown", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    expect(db.campaigns[0].recipient_count).toBe(2);
  });

  it("leaves a suppressed affiliate out entirely", async () => {
    db.suppressed.add("sam@example.com");
    const id = seedCampaign();
    await queueCampaign(id);
    expect(db.recipients.map((r) => r.email)).toEqual(["jordan@example.com"]);
  });
});

describe("each affiliate receives their own copy", () => {
  it("renders the merge variables from that affiliate's record", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    const jordan = db.delivered.find((m) => m.to === "jordan@example.com");
    const sam = db.delivered.find((m) => m.to === "sam@example.com");

    expect(jordan?.subject).toBe("Jordan, the sale is live");
    expect(sam?.subject).toBe("Sam, the sale is live");
    expect(jordan?.text).toContain("JORDAN10");
    expect(jordan?.text).toContain("15%");
    expect(sam?.text).toContain("SAM20");
    expect(sam?.text).toContain("20%");
    // The decisive assertion: the two messages are genuinely different.
    expect(jordan?.html).not.toBe(sam?.html);
  });

  it("leaves no unresolved variable in what actually goes out", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    for (const message of db.delivered) {
      expect(message.subject).not.toContain("{{");
      expect(message.html).not.toContain("{{");
      expect(message.text).not.toContain("{{");
    }
  });

  it("logs affiliate broadcasts under their own campaign type", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(db.delivered.every((m) => m.campaignType === "affiliate_campaign")).toBe(true);
  });
});

describe("a double-click cannot send twice", () => {
  it("refuses the second Send outright", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await expect(queueCampaign(id)).rejects.toBeInstanceOf(CampaignAlreadyStartedError);
  });

  it("delivers exactly one message per affiliate when Send is pressed twice", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await queueCampaign(id).catch(() => undefined);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    expect(db.delivered.filter((m) => m.to === "jordan@example.com")).toHaveLength(1);
    expect(db.delivered.filter((m) => m.to === "sam@example.com")).toHaveLength(1);
  });

  it("survives two clicks racing before either finishes queueing", async () => {
    const id = seedCampaign();
    const results = await Promise.allSettled([queueCampaign(id), queueCampaign(id)]);
    // Exactly one caller may claim the campaign.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(db.recipients).toHaveLength(2);
  });

  it("does not re-send when a sweep runs again after the campaign finished", async () => {
    const id = seedCampaign();
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    const afterFirst = db.delivered.length;
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(db.delivered).toHaveLength(afterFirst);
  });

  it("does not re-send a recipient whose row is already marked sent", async () => {
    // The retry / webhook-replay shape: the queue rows exist and are done.
    const id = seedCampaign();
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    db.campaigns[0].status = "sending";
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(db.delivered).toHaveLength(2);
  });
});

describe("a failure while queueing hands the campaign back", () => {
  it("restores the previous status instead of stranding it as sending", async () => {
    const id = seedCampaign();
    db.failAudience = true;

    await expect(queueCampaign(id)).rejects.toThrow("suppression list read failed");
    expect(db.campaigns[0].status).toBe("draft");
    expect(db.campaigns[0].started_at).toBeNull();
    expect(db.recipients).toHaveLength(0);
  });
});

describe("customer campaigns are untouched", () => {
  it("renders no personalisation and keeps its own campaign type", async () => {
    const id = seedCampaign({
      audience_kind: "customer",
      subject: "Our sale is live",
      body: "The sale is live.",
      affiliate_filter: null,
    });
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });

    expect(db.delivered).toHaveLength(1);
    expect(db.delivered[0].to).toBe("customer@example.com");
    expect(db.delivered[0].campaignType).toBe("campaign");
    expect(db.recipients[0].merge_context).toBeUndefined();
    expect(db.recipients[0].ambassador_id).toBeUndefined();
  });

  it("still leaves merge syntax alone in a customer campaign", async () => {
    // A customer campaign has no affiliate to resolve against, so tokens must
    // pass through untouched rather than being half-rendered.
    const id = seedCampaign({ audience_kind: "customer", subject: "Hello {{first_name}}", affiliate_filter: null });
    await queueCampaign(id);
    await sendCampaignBatch({ campaignId: id, budgetMs: 5000 });
    expect(db.delivered[0].subject).toBe("Hello {{first_name}}");
  });
});
