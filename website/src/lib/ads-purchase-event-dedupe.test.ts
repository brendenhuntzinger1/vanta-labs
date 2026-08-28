import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The Purchase conversion ledger must actually stop the second send.
//
// /api/ads/purchase-event/[orderId] is an unauthenticated GET that performs two
// outbound conversion sends (TikTok Events API, Reddit CAPI). Its protection
// against reporting the same sale twice is the ad_purchase_events_sent ledger:
// read the order's row, and if one exists, send nothing.
//
// Production proof that the guard was inert: a single GET against a real paid
// order returned
//   "TikTok Events API: delivered 1 event(s), code 0 | reddit: delivered in 42ms"
// and left NO row in ad_purchase_events_sent. Every later GET would send again.
//
// Two Postgres behaviours the previous test double did not model are what hid
// it, and this file models both:
//
//   1. ad_purchase_events_sent is PRIMARY KEY (order_id, platform). An upsert
//      declaring `onConflict: "order_id"` has no unique index matching that
//      conflict target, so Postgres raises 42P10 and writes nothing. The route
//      swallowed that error, so the ledger was never written.
//
//   2. PostgREST `.maybeSingle()` errors when more than one row matches. An
//      order legitimately holds one ledger row PER PLATFORM, so the single-row
//      read returns an error — and the route read that as "not sent yet".
//
// Both failures point the same way: toward sending again.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/admin-auth", () => ({
  getRequestIpAddress: () => "198.51.100.20",
  verifyAdminSessionFromCookie: async () => null,
}));

vi.mock("@/lib/order-attribution", () => ({
  getOrderAttribution: async () => null,
}));

const tiktokSends: unknown[] = [];
const redditSends: unknown[] = [];

vi.mock("@/lib/ads/tiktok-events-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ads/tiktok-events-api")>(
    "@/lib/ads/tiktok-events-api",
  );
  return {
    ...actual,
    credentialStatus: () => ({ configured: true, missing: [] }),
    sendServerEvents: async (events: unknown[]) => {
      tiktokSends.push(events);
      return { delivered: true, tiktokCode: 0, attempted: 1 };
    },
    describeResult: () => "TikTok Events API: delivered 1 event(s), code 0",
  };
});

vi.mock("@/lib/ads/reddit-conversions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ads/reddit-conversions")>(
    "@/lib/ads/reddit-conversions",
  );
  return {
    ...actual,
    redditCredentialStatus: () => ({ configured: true, missing: [] }),
    sendRedditConversion: async (input: unknown) => {
      redditSends.push(input);
      return { delivered: true, status: 200 };
    },
    describeRedditResult: () => "reddit: delivered in 42ms",
  };
});

const ORDER_ID = "order-b8a56a42-d949-48a6-9a9a-b408d51c5006";

type Row = Record<string, unknown>;

/**
 * The ledger, with the real primary key enforced.
 *
 * `PK` is the ONLY valid conflict target, exactly as in Postgres: an upsert
 * naming anything else gets 42P10 and writes nothing, and `maybeSingle` over a
 * filter matching two rows gets PGRST116 rather than silently the first one.
 */
const LEDGER_PK = ["order_id", "platform"];
let ledger: Row[] = [];

vi.mock("@/lib/supabase-server", () => {
  const order = {
    order_id: ORDER_ID,
    payment_status: "paid",
    amount_paid: 76.04,
    customer_email: "buyer@example.com",
    customer_user_id: null,
    order_items: [{ product_id: "p1", product_name: "GLP-1 (5mg)", quantity: 1, unit_price: 54.99 }],
  };

  const from = (table: string) => {
    const filters: Row[] = [];
    const builder: Record<string, unknown> = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
      in() { return builder; },
      async upsert(payload: Row, options?: { onConflict?: string }) {
        const target = (options?.onConflict ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        const sameTarget =
          target.length === LEDGER_PK.length && LEDGER_PK.every((k) => target.includes(k));
        if (!sameTarget) {
          // Postgres: there is no unique or exclusion constraint matching the
          // ON CONFLICT specification.
          return { data: null, error: { code: "42P10", message: "no unique constraint matching ON CONFLICT" } };
        }
        const existing = ledger.find((row) => LEDGER_PK.every((k) => row[k] === payload[k]));
        if (existing) Object.assign(existing, payload);
        else ledger.push({ ...payload });
        return { data: null, error: null };
      },
      async maybeSingle() {
        const matched = rows().filter((row) => filters.every((f) => row[f.column as string] === f.value));
        if (matched.length > 1) {
          // PostgREST: JSON object requested, multiple rows returned.
          return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
        }
        return { data: matched[0] ?? null, error: null };
      },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        const matched = rows().filter((row) => filters.every((f) => row[f.column as string] === f.value));
        return Promise.resolve({ data: matched, error: null }).then(resolve);
      },
    };

    function rows(): Row[] {
      if (table === "orders") return [order as Row];
      if (table === "products") return [{ id: "p1", slug: "glp-1", category: "peptide" }];
      if (table === "ad_purchase_events_sent") return ledger;
      return [];
    }

    return builder;
  };

  return { supabaseAdmin: { from } };
});

const context = () => ({ params: Promise.resolve({ orderId: ORDER_ID }) });
const request = () => new Request(`https://vanta.test/api/ads/purchase-event/${ORDER_ID}`);

async function GET() {
  return (await import("@/app/api/ads/purchase-event/[orderId]/route")).GET;
}

beforeEach(() => {
  ledger = [];
  tiktokSends.length = 0;
  redditSends.length = 0;
});

describe("the Purchase conversion ledger stops the second send", () => {
  it("writes a ledger row for every platform it sent on", async () => {
    const handler = await GET();
    await handler(request(), context());

    // A send that leaves no ledger row is a send with no memory of itself.
    expect(ledger.map((row) => row.platform).sort()).toEqual(["reddit", "tiktok"]);
    expect(ledger.every((row) => row.order_id === ORDER_ID)).toBe(true);
  });

  it("reports one sale once, however many times the confirmation link is opened", async () => {
    const handler = await GET();
    await handler(request(), context());
    await handler(request(), context());
    await handler(request(), context());

    expect(tiktokSends).toHaveLength(1);
    expect(redditSends).toHaveLength(1);
  });

  it("does not re-send after a platform's row is already on the ledger", async () => {
    ledger = [
      { order_id: ORDER_ID, event_id: "purchase-" + ORDER_ID, platform: "tiktok", delivered: true },
      { order_id: ORDER_ID, event_id: "purchase-" + ORDER_ID, platform: "reddit", delivered: true },
    ];

    const handler = await GET();
    await handler(request(), context());

    expect(tiktokSends).toHaveLength(0);
    expect(redditSends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F-02 — AND THE DDL FILE HAS TO SAY THE SAME THING THE MODEL ABOVE ASSUMES.
//
// Everything above encodes `PRIMARY KEY (order_id, platform)` and proves the
// route breaks without it. Nothing asserted that the repo's own DDL declared
// it — and it did not: ads-purchase-idempotency.sql said `order_id text
// primary key` while production carried the composite key. Queried 2026-08-28:
//
//   select conname, pg_get_constraintdef(oid) from pg_constraint
//   where conrelid = 'public.ad_purchase_events_sent'::regclass;
//   -> ad_purchase_events_sent_pkey  PRIMARY KEY (order_id, platform)
//
// So the drift was repo-only and the file has been corrected. It was not
// harmless while it lasted: `create table if not exists` is what the local
// harness and any fresh environment run, and there the route's every upsert
// would have hit 42P10 against a conflict target that does not exist — the
// exact inert-ledger failure this file was written to catch, reintroduced by
// the schema rather than the code, where none of the tests above would see it.
// ---------------------------------------------------------------------------
describe("F-02: the ledger DDL declares the key the route upserts on", () => {
  const ddl = readFileSync(resolve(process.cwd(), "src/lib/sql/ads-purchase-idempotency.sql"), "utf8");

  /** Comments stripped: the prose above quotes the very form being banned. */
  const body = ddl.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("declares the composite primary key production actually has", () => {
    expect(body).toMatch(/primary\s+key\s*\(\s*order_id\s*,\s*platform\s*\)/i);
  });

  it("does not declare order_id as a primary key on its own", () => {
    // The stale form. One row per ORDER means TikTok's send permanently
    // suppresses Reddit's, and every upsert naming the composite target fails.
    expect(body).not.toMatch(/order_id\s+text\s+primary\s+key/i);
  });

  it("agrees with the conflict target the route names", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts"),
      "utf8",
    );
    expect(route).toContain('onConflict: "order_id,platform"');
  });
});
