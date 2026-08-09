import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeAttribution, parseAttributionTouch, toAnalyticsAttribution, type AttributionRecord } from "@/lib/attribution";

// End-to-end simulation of the two journeys that decide whether this system is
// trustworthy: a paid TikTok click that must keep its attribution all the way to
// a paid order, and an organic visitor whose sale must NEVER be credited to an
// ad. Everything in between — the analytics session, the product view, the cart,
// the checkout POST, the payment webhook — is walked through the real functions.

type Row = Record<string, unknown>;

const db = new Map<string, Row>();
const failures = { upsert: null as string | null, throwOnUpsert: false };

function tableClient(table: string) {
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "upsert" = "select";
  let payload: Row | null = null;

  const run = async (single: boolean) => {
    if (table !== "order_attribution") return { data: null, error: null };

    if (op === "upsert") {
      if (failures.throwOnUpsert) throw new Error("connection reset");
      if (failures.upsert) return { data: null, error: { message: failures.upsert } };
      db.set(String(payload!.order_id), { ...payload });
      return { data: payload, error: null };
    }

    const hits = [...db.values()].filter((row) => filters.every(([col, val]) => row[col] === val));
    return { data: single ? (hits[0] ? { ...hits[0] } : null) : hits, error: null };
  };

  const query = {
    select: () => query,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return query; },
    upsert: (value: Row) => { op = "upsert"; payload = value; return query; },
    maybeSingle: () => run(true),
    single: () => run(true),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run(false).then(res, rej),
  };
  return query;
}

vi.mock("@/lib/supabase-server", () => ({
  createServerClient: () => ({ from: tableClient }),
  supabaseAdmin: { from: (table: string) => tableClient(table) },
}));

const { recordOrderAttribution, getOrderAttribution } = await import("@/lib/order-attribution");

const NOW = new Date("2026-08-09T12:00:00.000Z");

/** Replays what the browser actually does across a multi-page visit. */
function browseAndBuild(steps: Array<{ search: string; pathname: string; referrer?: string | null; at: Date }>): AttributionRecord | null {
  let record: AttributionRecord | null = null;
  for (const step of steps) {
    const touch = parseAttributionTouch({
      search: step.search,
      pathname: step.pathname,
      referrer: step.referrer ?? null,
      now: step.at,
    });
    record = mergeAttribution(record, touch, { now: step.at, visitorId: "visitor-abc", sessionId: "session-xyz" });
  }
  return record;
}

beforeEach(() => {
  db.clear();
  failures.upsert = null;
  failures.throwOnUpsert = false;
});

describe("SIMULATION 1 — TikTok click survives to the paid order", () => {
  it("carries ttclid and campaign from the ad click through checkout to the purchase event", async () => {
    // Ad click → lands on the product page with the click id in the URL.
    // Then browses: product view, cart, checkout. The query string is gone
    // after the first hop, which is exactly why capture happens on arrival.
    const record = browseAndBuild([
      { search: "?ttclid=E.C.P.TikTok123&utm_source=tiktok&utm_medium=paid_social&utm_campaign=bpc_launch&utm_content=hook_a", pathname: "/products/bpc-157", referrer: "https://www.tiktok.com/", at: NOW },
      { search: "", pathname: "/products/bpc-157", at: NOW },
      { search: "", pathname: "/cart", at: NOW },
      { search: "", pathname: "/checkout", at: NOW },
    ]);

    expect(record!.last!.ttclid).toBe("E.C.P.TikTok123");

    // Checkout POST → server re-validates and stores.
    const outcome = await recordOrderAttribution({ orderId: "order-tiktok-1", raw: record, now: NOW });
    expect(outcome.recorded).toBe(true);

    // Payment webhook marks the order paid and reads the link back.
    const stored = await getOrderAttribution("order-tiktok-1");
    expect(stored!.last!.ttclid).toBe("E.C.P.TikTok123");
    expect(stored!.last!.utmSource).toBe("tiktok");
    expect(stored!.last!.utmCampaign).toBe("bpc_launch");
    expect(stored!.last!.utmContent).toBe("hook_a");
    expect(stored!.visitorId).toBe("visitor-abc");
    expect(stored!.sessionId).toBe("session-xyz");
    // The landing page is preserved, which is what makes landing-page
    // performance answerable later.
    expect(stored!.last!.landingPath).toBe("/products/bpc-157");

    // And the purchase event can finally be grouped by campaign.
    expect(toAnalyticsAttribution(stored)).toEqual({
      utm_source: "tiktok",
      utm_medium: "paid_social",
      utm_campaign: "bpc_launch",
      visitor_id: "visitor-abc",
    });
  });

  it("credits the finding campaign as first touch and the closing one as last", async () => {
    const record = browseAndBuild([
      { search: "?utm_source=tiktok&ttclid=t1&utm_campaign=discovery", pathname: "/products/bpc-157", at: new Date(NOW.getTime() - 6 * 864e5) },
      { search: "?utm_source=tiktok&ttclid=t2&utm_campaign=retargeting", pathname: "/products/bpc-157", at: NOW },
    ]);

    await recordOrderAttribution({ orderId: "order-two-touch", raw: record, now: NOW });
    const stored = await getOrderAttribution("order-two-touch");

    expect(stored!.first!.utmCampaign).toBe("discovery");
    expect(stored!.last!.utmCampaign).toBe("retargeting");
  });
});

describe("SIMULATION 2 — organic sale is never credited to an ad", () => {
  it("writes no attribution row for a direct visitor", async () => {
    const record = browseAndBuild([
      { search: "", pathname: "/", at: NOW },
      { search: "", pathname: "/products", at: NOW },
      { search: "", pathname: "/products/bpc-157", at: NOW },
      { search: "", pathname: "/checkout", at: NOW },
    ]);

    const outcome = await recordOrderAttribution({ orderId: "order-organic-1", raw: record, now: NOW });

    // Identity is known, so a row IS written — but with no campaign in it.
    const stored = await getOrderAttribution("order-organic-1");
    expect(outcome.recorded).toBe(true);
    expect(stored!.visitorId).toBe("visitor-abc");
    expect(stored!.first).toBeNull();
    expect(stored!.last).toBeNull();

    // The purchase event stays unattributed. This is the assertion that keeps
    // organic revenue out of the paid column.
    expect(toAnalyticsAttribution(stored)).toEqual({
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      visitor_id: "visitor-abc",
    });
  });

  it("does not credit an ad when the visitor merely arrived from tiktok.com", async () => {
    const record = browseAndBuild([
      { search: "", pathname: "/products/bpc-157", referrer: "https://www.tiktok.com/@vantalabs", at: NOW },
      { search: "", pathname: "/checkout", at: NOW },
    ]);

    await recordOrderAttribution({ orderId: "order-organic-social", raw: record, now: NOW });
    const stored = await getOrderAttribution("order-organic-social");

    expect(stored!.last).toBeNull();
    expect(toAnalyticsAttribution(stored).utm_source).toBeNull();
  });

  it("stores nothing at all when even identity is unknown (cookies declined)", async () => {
    const outcome = await recordOrderAttribution({ orderId: "order-no-consent", raw: null, now: NOW });
    expect(outcome).toEqual({ recorded: false, reason: "no_attribution" });
    expect(await getOrderAttribution("order-no-consent")).toBeNull();
  });
});

describe("analytics must never be able to disturb commerce", () => {
  it("resolves rather than throwing when the write fails", async () => {
    failures.upsert = 'relation "order_attribution" does not exist';
    const record = browseAndBuild([{ search: "?ttclid=t1", pathname: "/", at: NOW }]);

    // A missing migration must degrade to "no attribution", never to a failed
    // checkout — this module ships before its SQL is run.
    await expect(recordOrderAttribution({ orderId: "order-x", raw: record, now: NOW })).resolves.toEqual({
      recorded: false,
      reason: "write_failed",
    });
  });

  it("swallows an unexpected exception", async () => {
    failures.throwOnUpsert = true;
    const record = browseAndBuild([{ search: "?ttclid=t1", pathname: "/", at: NOW }]);
    await expect(recordOrderAttribution({ orderId: "order-y", raw: record, now: NOW })).resolves.toEqual({
      recorded: false,
      reason: "exception",
    });
  });

  it("rejects a write with no order id", async () => {
    const record = browseAndBuild([{ search: "?ttclid=t1", pathname: "/", at: NOW }]);
    expect(await recordOrderAttribution({ orderId: "  ", raw: record, now: NOW })).toEqual({
      recorded: false,
      reason: "missing_order_id",
    });
  });

  it("returns null rather than throwing for an unknown order", async () => {
    expect(await getOrderAttribution("nope")).toBeNull();
    expect(await getOrderAttribution("")).toBeNull();
  });

  // A crafted checkout POST is the one way a customer could try to attribute
  // their own organic order to a campaign (or someone else's).
  it("refuses a forged campaign supplied directly in the checkout body", async () => {
    const forged = { visitorId: "v1", last: { landingPath: "/checkout", referrer: "https://tiktok.com", at: NOW.toISOString() } };
    await recordOrderAttribution({ orderId: "order-forged", raw: forged, now: NOW });
    const stored = await getOrderAttribution("order-forged");
    expect(stored!.last).toBeNull();
  });
});
