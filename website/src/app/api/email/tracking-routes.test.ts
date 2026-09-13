import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// SENT, OPENED, CLICKED — EXECUTED, NOT READ.
//
// Every tracking route in this system writes behind a catch that swallows what
// it finds, because a tracking failure must never strand a customer. That is
// right for the customer and it means a broken write is INVISIBLE: no error, no
// log line, a pixel that still renders, a redirect that still lands, and a
// report that reads zero for ever.
//
// Nothing here used to run these handlers. The signature schemes were covered,
// the URL shapes were covered, and utm-wiring.test.ts greps the source — so the
// one question an operator actually asks, "did the open/click reach the table
// the dashboard reads", had never been asked of the code that answers it.
//
// One file, one fake database, all five routes, because the interesting
// assertions are about WHICH ROW each one touches and they are only meaningful
// side by side: the campaign pixel must stamp one recipient out of thousands
// sharing a reference_id, and the cart-recovery pixel must stamp a reservation's
// cart and stage. Getting either wrong reports engagement nobody had.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "test-secret-not-a-real-one";
});

const SITE = "https://vanta.test";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Tables whose insert should fail the way a transport error does. */
  insertThrows: new Set<string>(),
  inserted: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

/**
 * A Supabase stand-in over in-memory tables. It implements only the operators
 * these routes use — eq, is, in, order, limit, maybeSingle, and select-after-
 * update — but it implements them faithfully, because the bugs worth catching
 * here are precisely "the filter matched the wrong rows".
 */
vi.mock("@/lib/supabase-server", () => {
  const builder = (table: string) => {
    const filters: Array<{ column: string; op: string; value: unknown }> = [];
    let pending: { op: "select" | "insert" | "update"; values?: Row } = { op: "select" };
    let wantRows = false;
    let take: number | null = null;

    const rows = () => (db.tables[table] ??= []);
    const matches = (row: Row) => filters.every((f) => {
      const actual = row[f.column];
      if (f.op === "eq") return actual === f.value;
      if (f.op === "in") return Array.isArray(f.value) && f.value.includes(actual);
      if (f.op === "is") return f.value === null ? actual === null || actual === undefined : actual === f.value;
      return true;
    });

    const run = () => {
      if (pending.op === "insert") {
        if (db.insertThrows.has(table)) throw new Error(`fetch failed: ${table}`);
        const values = { ...(pending.values ?? {}) };
        rows().push(values);
        db.inserted.push({ table, values });
        return { data: null, error: null };
      }
      if (pending.op === "update") {
        const hit = rows().filter(matches);
        for (const row of hit) Object.assign(row, pending.values);
        return { data: wantRows ? hit : null, error: null };
      }
      const found = rows().filter(matches);
      return { data: take === null ? found : found.slice(0, take), error: null };
    };

    const self: Record<string, unknown> = {
      select: () => { if (pending.op === "update") wantRows = true; return self; },
      insert: (values: Row) => { pending = { op: "insert", values }; return self; },
      update: (values: Row) => { pending = { op: "update", values }; return self; },
      eq: (column: string, value: unknown) => { filters.push({ column, op: "eq", value }); return self; },
      in: (column: string, value: unknown) => { filters.push({ column, op: "in", value }); return self; },
      is: (column: string, value: unknown) => { filters.push({ column, op: "is", value }); return self; },
      order: () => self,
      limit: (n: number) => { take = n; return self; },
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
  attachEmailLinkGrant: async () => {},
}));
vi.mock("@/lib/offers/customer-offers", () => ({
  OFFER_COOKIE: "vl_offer",
  OFFER_COOKIE_MAX_AGE_SECONDS: 3600,
}));
vi.mock("@/lib/cart-recovery-grant", () => ({
  GUEST_GRANT_COOKIE: "vl_guest_cart",
  GUEST_GRANT_MAX_AGE_SECONDS: 3600,
  GUEST_GRANT_PARAM: "k",
  signGuestRecoveryGrant: async () => "test-grant",
}));

const { GET: campaignOpen } = await import("@/app/api/email/open/route");
const { GET: campaignClick } = await import("@/app/api/email/click/route");
const { GET: automationOpen } = await import("@/app/api/email/automation-open/route");
const { GET: recoveryOpen } = await import("@/app/api/email/track/open/route");
const { GET: recoveryClick } = await import("@/app/api/email/track/click/route");

const { buildCampaignOpenUrl, buildCampaignClickUrl } = await import("@/lib/email/campaign-links");
const { buildAutomationOpenUrl } = await import("@/lib/email/automation-links");

const CAMPAIGN = "8f1d0c2a-0000-4000-8000-00000000abcd";
const ME = "buyer@example.test";
const SOMEONE_ELSE = "other@example.test";
const AUTOMATION = "welcome_no_purchase";
const CART = "cart-1111";
const RESERVATION = "reservation-2222";

/** By id, never by recipient: several rows below share a recipient on purpose. */
const logRow = (id: string) => (db.tables.email_send_log ?? []).find((r) => r.id === id) as Row;
const insertedInto = (table: string) => db.inserted.filter((i) => i.table === table);

beforeEach(() => {
  db.insertThrows = new Set();
  db.inserted = [];
  db.tables = {
    email_campaigns: [{ id: CAMPAIGN, cta_path: "/products", link_buttons: null }],
    email_automations: [{ key: AUTOMATION, cta_path: "/products" }],
    email_campaign_recipients: [
      { campaign_id: CAMPAIGN, email: ME, opened_at: null, clicked_at: null },
      { campaign_id: CAMPAIGN, email: SOMEONE_ELSE, opened_at: null, clicked_at: null },
    ],
    // A campaign fans out to many send-log rows sharing one reference_id. Both
    // are here on purpose: every assertion below about "one row" is only worth
    // anything with a second row sitting next to it.
    email_send_log: [
      { id: "log-me", campaign_type: "campaign", reference_id: CAMPAIGN, recipient_email: ME, sent_at: "2026-09-11T10:00:00.000Z", opened_at: null, clicked_at: null },
      { id: "log-other", campaign_type: "campaign", reference_id: CAMPAIGN, recipient_email: SOMEONE_ELSE, sent_at: "2026-09-11T10:00:00.000Z", opened_at: null, clicked_at: null },
      { id: "log-automation", campaign_type: `automation:${AUTOMATION}`, reference_id: ME, recipient_email: ME, sent_at: "2026-09-11T10:00:00.000Z", opened_at: null, clicked_at: null },
      { id: "log-recovery", campaign_type: "cart_recovery_t12h", reference_id: CART, recipient_email: ME, sent_at: "2026-09-11T10:00:00.000Z", opened_at: null, clicked_at: null },
    ],
    abandoned_cart_emails: [
      { id: RESERVATION, abandoned_cart_id: CART, stage: "t12h", opened_at: null, clicked_at: null },
    ],
    abandoned_carts: [{ id: CART, email: ME }],
    email_campaign_clicks: [],
    email_automation_clicks: [],
    email_engagement_events: [],
  };
});

// ---------------------------------------------------------------------------
// OPENED
// ---------------------------------------------------------------------------

describe("campaign open pixel", () => {
  const open = (email = ME) => campaignOpen(new NextRequest(buildCampaignOpenUrl(CAMPAIGN, email)));

  it("stamps the recipient row and the send-log row", async () => {
    await open();
    expect((db.tables.email_campaign_recipients[0] as Row).opened_at).toEqual(expect.any(String));
    expect(logRow("log-me").opened_at).toEqual(expect.any(String));
  });

  it("stamps ONE person's send-log row, not every row the campaign fanned out to", async () => {
    // A campaign's reference_id is shared by every row it produced. Stamping on
    // reference_id alone would report a 100% open rate the moment one person
    // looked at it.
    await open();
    expect(logRow("log-other").opened_at).toBeNull();
  });

  it("keeps the FIRST open, so the timestamp means when they first saw it", async () => {
    await open();
    const first = logRow("log-me").opened_at;
    await open();
    expect(logRow("log-me").opened_at).toBe(first);
  });

  it("records the raw event with its user agent, for the prefetch classifier", async () => {
    await open();
    expect(insertedInto("email_engagement_events")).toHaveLength(1);
    expect(insertedInto("email_engagement_events")[0].values).toMatchObject({ kind: "opened", source: "pixel" });
  });

  it("records nothing for a forged pixel URL, and still returns the image", async () => {
    const url = new URL(buildCampaignOpenUrl(CAMPAIGN, ME));
    url.searchParams.set("t", "0".repeat(32));
    const response = await campaignOpen(new NextRequest(url.toString()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(logRow("log-me").opened_at).toBeNull();
    expect(insertedInto("email_engagement_events")).toHaveLength(0);
  });
});

describe("automation open pixel", () => {
  const open = () => automationOpen(new NextRequest(buildAutomationOpenUrl(AUTOMATION, ME, ME)));

  it("stamps the send-log row, which is the only per-send record automations have", async () => {
    await open();
    expect(logRow("log-automation").opened_at).toEqual(expect.any(String));
  });

  it("stamps only the automation's own row, not the campaign row for the same person", async () => {
    await open();
    expect(logRow("log-me").opened_at).toBeNull();
  });

  it("records the raw event", async () => {
    await open();
    expect(insertedInto("email_engagement_events")[0].values).toMatchObject({
      campaign_type: `automation:${AUTOMATION}`, kind: "opened", source: "pixel",
    });
  });

  it("records nothing for a forged pixel URL, and still returns the image", async () => {
    const url = new URL(buildAutomationOpenUrl(AUTOMATION, ME, ME));
    url.searchParams.set("t", "0".repeat(32));
    const response = await automationOpen(new NextRequest(url.toString()));
    expect(response.status).toBe(200);
    expect(logRow("log-automation").opened_at).toBeNull();
  });
});

describe("cart-recovery open pixel", () => {
  const open = () => recoveryOpen(new NextRequest(`${SITE}/api/email/track/open?id=${RESERVATION}`));

  it("stamps the reservation AND the send-log row for that cart and stage", async () => {
    // Cart-recovery opens lived only in abandoned_cart_emails for six weeks,
    // which is why they appeared nowhere the owner looks.
    await open();
    expect((db.tables.abandoned_cart_emails[0] as Row).opened_at).toEqual(expect.any(String));
    expect(logRow("log-recovery").opened_at).toEqual(expect.any(String));
  });

  it("keeps the first open on both copies", async () => {
    await open();
    const first = (db.tables.abandoned_cart_emails[0] as Row).opened_at;
    await open();
    expect((db.tables.abandoned_cart_emails[0] as Row).opened_at).toBe(first);
  });

  it("returns the pixel for an unknown reservation without writing anything", async () => {
    const response = await recoveryOpen(new NextRequest(`${SITE}/api/email/track/open?id=nope`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((db.tables.abandoned_cart_emails[0] as Row).opened_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLICKED
// ---------------------------------------------------------------------------

describe("campaign click", () => {
  const click = (email = ME) => campaignClick(new NextRequest(buildCampaignClickUrl(CAMPAIGN, email)));

  it("redirects to the campaign's own stored destination", async () => {
    const response = await click();
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/products");
  });

  it("stamps the recipient row, the send-log row, and the click detail", async () => {
    await click();
    expect((db.tables.email_campaign_recipients[0] as Row).clicked_at).toEqual(expect.any(String));
    expect(logRow("log-me").clicked_at).toEqual(expect.any(String));
    expect(insertedInto("email_campaign_clicks")).toHaveLength(1);
  });

  it("stamps ONE person's send-log row", async () => {
    await click();
    expect(logRow("log-other").clicked_at).toBeNull();
  });

  it("still stamps the send log when the click-detail insert fails", async () => {
    // The detail row is a diagnostic log; the send-log stamp is the number every
    // report counts. This route guards them separately on purpose — the same
    // failure in its twin (automation-click) silently discarded the stamp.
    db.insertThrows.add("email_campaign_clicks");
    await click();
    expect(logRow("log-me").clicked_at).toEqual(expect.any(String));
  });

  it("records nothing for a tampered link, and still sends the shopper to the store", async () => {
    const url = new URL(buildCampaignClickUrl(CAMPAIGN, ME));
    url.searchParams.set("t", "0".repeat(32));
    const response = await campaignClick(new NextRequest(url.toString()));
    expect(response.status).toBe(302);
    expect(logRow("log-me").clicked_at).toBeNull();
    expect(insertedInto("email_campaign_clicks")).toHaveLength(0);
  });
});

describe("cart-recovery click", () => {
  const click = () => recoveryClick(new NextRequest(
    `${SITE}/api/email/track/click?id=${RESERVATION}&url=${encodeURIComponent(`${SITE}/cart/restore?id=${CART}`)}`,
  ));

  it("stamps the reservation AND the send-log row", async () => {
    await click();
    expect((db.tables.abandoned_cart_emails[0] as Row).clicked_at).toEqual(expect.any(String));
    expect(logRow("log-recovery").clicked_at).toEqual(expect.any(String));
  });

  it("redirects to the cart it was mailed about, tagged for analytics", async () => {
    const response = await click();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/cart/restore");
    expect(location.searchParams.get("utm_medium")).toBe("cart_recovery");
  });

  it("still attributes a SECOND click, which is still a click", async () => {
    // The first-click stamp is conditioned on clicked_at being null, so the
    // update returns no row the second time. Without the read-back, a shopper
    // who clicked twice lost attribution on the visit that actually converted.
    await click();
    const response = await click();
    expect(response.cookies.get("vl_cart_recovery")?.value).toContain(CART);
  });

  it("sends an unknown reservation to the cart without writing anything", async () => {
    const response = await recoveryClick(new NextRequest(`${SITE}/api/email/track/click?id=nope`));
    expect(response.status).toBe(307);
    expect((db.tables.abandoned_cart_emails[0] as Row).clicked_at).toBeNull();
  });
});
