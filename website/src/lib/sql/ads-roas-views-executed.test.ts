import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE ROAS VIEWS, EXECUTED — not described.
//
// Every invariant this file proves is one that a unit test over TypeScript
// cannot reach, because the arithmetic happens in Postgres. The two that matter
// most are also the two that would be invisible in production:
//
//   THE FAN-OUT. `ad_spend_daily` is one row per AD; `ad_revenue_daily` is one
//   row per (platform, day, campaign, creative). Joining those directly means
//   two ads sharing one utm_content EACH match the single revenue row, and the
//   sum reports that creative's revenue twice. The first version of the views
//   did exactly this. Nothing would have failed: the dashboard would simply have
//   shown a ROAS that was too good, and only once the owner started tagging ads
//   sensibly — which is the whole point of the system.
//
//   THE STATUS FILTER. `amount_paid` is non-zero on cancelled and failed orders
//   in this database. Without `payment_status = 'paid'` the views report revenue
//   the store never took.
//
// So the shipped file is loaded verbatim and run against a real Postgres. Not a
// paraphrase of it — a test that restates a view definition passes while the
// file that actually deploys says something else.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  // stderr, not console.warn: vitest swallows console output for a skipped
  // module, which is how dead proofs report success.
  process.stderr.write(
    "[ads-roas-views-executed] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it. " +
      "These cover the revenue fan-out, the paid-order filter, refund netting and cross-platform leakage, " +
      "and are NOT covered by any in-memory test.\n",
  );
}

const SQL_PATH = path.resolve(__dirname, "ads-spend-roas.sql");

/**
 * Just enough of production's shape for the views to run against.
 *
 * `orders` and `order_attribution` are stubs; `ad_spend_daily` and every view
 * come from the SHIPPED file, so what is under test is what deploys.
 */
const PREREQ = `
create table orders (
  order_id text primary key,
  payment_status text not null default 'paid',
  amount_paid numeric not null default 0,
  refund_amount numeric not null default 0,
  -- The one-source stamp. ad_revenue_daily reads it so an order the store has
  -- already credited to a campaign, an automation or cart recovery is not ALSO
  -- counted as ad revenue against ad spend.
  marketing_source_kind text,
  created_at timestamptz not null default now()
);
create table order_attribution (
  order_id text primary key,
  last_utm_source text,
  last_utm_campaign text,
  last_utm_content text
);
`;

/** The shipped migration, minus the two statements that need a live Supabase. */
function shippedSql(): string {
  return readFileSync(SQL_PATH, "utf8")
    // anon/authenticated are Supabase roles that do not exist in a bare Postgres.
    .replace(/^revoke all on .*from anon, authenticated;$/gm, "")
    .replace(/^revoke all on function .*from public;$/gm, "")
    // RLS on a table owned by the test role is a no-op here and needs no proof.
    .replace(/^alter table public\.ad_spend_daily enable row level security;$/gm, "");
}

describeDb("the ROAS views, run against a real Postgres", () => {
  let client: Client;

  beforeAll(async () => {
    const url = await createSuiteDatabase(DATABASE_URL!, "ads_roas_views");
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(PREREQ);
    await client.query(shippedSql());
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  async function reset() {
    await client.query("truncate orders, order_attribution, ad_spend_daily");
  }

  async function addSpend(rows: Array<Record<string, unknown>>) {
    for (const r of rows) {
      await client.query(
        `insert into ad_spend_daily
           (platform, ad_id, stat_date, campaign_name, ad_name, landing_url,
            utm_content, utm_campaign, spend, impressions, clicks, platform_conversions)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          r.platform, r.ad_id, r.stat_date, r.campaign_name ?? null, r.ad_name ?? null,
          r.landing_url ?? null, r.utm_content ?? null, r.utm_campaign ?? null,
          r.spend ?? 0, r.impressions ?? 0, r.clicks ?? 0, r.platform_conversions ?? null,
        ],
      );
    }
  }

  async function addOrder(o: Record<string, unknown>) {
    await client.query(
      `insert into orders (order_id, payment_status, amount_paid, refund_amount, marketing_source_kind, created_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        o.order_id,
        o.payment_status ?? "paid",
        o.amount_paid ?? 0,
        o.refund_amount ?? 0,
        o.marketing_source_kind ?? null,
        o.created_at,
      ],
    );
    await client.query(
      `insert into order_attribution (order_id, last_utm_source, last_utm_campaign, last_utm_content)
       values ($1,$2,$3,$4)`,
      [o.order_id, o.last_utm_source ?? null, o.last_utm_campaign ?? null, o.last_utm_content ?? null],
    );
  }

  const D = "2026-09-05";
  const T = `${D}T12:00:00Z`;

  // -------------------------------------------------------------------------
  // THE FAN-OUT
  // -------------------------------------------------------------------------

  describe("multi-row spend against multi-order revenue does not multiply", () => {
    beforeAll(async () => {
      await reset();
      // THREE ads sharing one creative tag on one platform and day, and TWO
      // orders attributed to that tag. A direct join produces 3 x 2 = 6 pairings
      // and reports $600 of revenue against $300 of spend.
      await addSpend([
        { platform: "tiktok", ad_id: "a1", stat_date: D, utm_content: "hook_a", utm_campaign: "launch", spend: 100, impressions: 1000, clicks: 50 },
        { platform: "tiktok", ad_id: "a2", stat_date: D, utm_content: "hook_a", utm_campaign: "launch", spend: 100, impressions: 1000, clicks: 50 },
        { platform: "tiktok", ad_id: "a3", stat_date: D, utm_content: "hook_a", utm_campaign: "launch", spend: 100, impressions: 1000, clicks: 50 },
      ]);
      await addOrder({ order_id: "o1", amount_paid: 150, created_at: T, last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a" });
      await addOrder({ order_id: "o2", amount_paid: 150, created_at: T, last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a" });
    });

    // MEASURED AGAINST THE OLD DEFINITION, not assumed. The pre-fix view — spend
    // joined to revenue with no pre-aggregation — returns for this exact fixture:
    //
    //   rows_for_one_creative | spend | revenue
    //                       3 |   300 |     900
    //
    // Three rows for one creative, revenue tripled, ROAS 3.0 against a truth of
    // 1.0. Every assertion below fails against that shape.
    it("reports the creative once, with revenue counted once", async () => {
      const { rows } = await client.query(
        `select utm_content, ads, spend, orders, net_revenue, roas
           from ad_creative_roas_daily where platform='tiktok'`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].ads)).toBe(3);
      expect(Number(rows[0].spend)).toBe(300);
      expect(Number(rows[0].orders)).toBe(2);
      // $300, not $600. This is the assertion the original views failed.
      expect(Number(rows[0].net_revenue)).toBe(300);
      expect(Number(rows[0].roas)).toBeCloseTo(1, 6);
    });

    it("returns exactly one row per (platform, day, creative) — the fan-out guard", async () => {
      const { rows } = await client.query(
        `select count(*)::int as dupes from (
           select platform, stat_date, utm_content
             from ad_creative_roas_daily group by 1,2,3 having count(*) > 1
         ) x`,
      );
      expect(rows[0].dupes).toBe(0);
    });

    it("does not multiply at campaign or platform grain either", async () => {
      const campaign = await client.query(`select spend, orders, net_revenue from ad_campaign_daily where platform='tiktok'`);
      expect(campaign.rows).toHaveLength(1);
      expect(Number(campaign.rows[0].spend)).toBe(300);
      expect(Number(campaign.rows[0].net_revenue)).toBe(300);

      const platform = await client.query(`select spend, orders, net_revenue, clicks, impressions from ad_platform_daily where platform='tiktok'`);
      expect(platform.rows).toHaveLength(1);
      expect(Number(platform.rows[0].spend)).toBe(300);
      expect(Number(platform.rows[0].net_revenue)).toBe(300);
      // Clicks and impressions must not multiply either.
      expect(Number(platform.rows[0].clicks)).toBe(150);
      expect(Number(platform.rows[0].impressions)).toBe(3000);
    });
  });

  // -------------------------------------------------------------------------
  // WHAT COUNTS AS REVENUE
  // -------------------------------------------------------------------------

  describe("only paid orders count, and refunds net off", () => {
    beforeAll(async () => {
      await reset();
      await addSpend([{ platform: "reddit", ad_id: "r1", stat_date: D, utm_content: "hook_r", utm_campaign: "c", spend: 100, clicks: 10, impressions: 500 }]);
      const attribution = { last_utm_source: "reddit", last_utm_campaign: "c", last_utm_content: "hook_r" };
      await addOrder({ order_id: "paid", payment_status: "paid", amount_paid: 200, created_at: T, ...attribution });
      await addOrder({ order_id: "refunded-part", payment_status: "paid", amount_paid: 100, refund_amount: 40, created_at: T, ...attribution });
      // Each of these carries a non-zero amount_paid, exactly as production does.
      await addOrder({ order_id: "cancelled", payment_status: "canceled", amount_paid: 500, created_at: T, ...attribution });
      await addOrder({ order_id: "failed", payment_status: "payment_failed", amount_paid: 500, created_at: T, ...attribution });
      await addOrder({ order_id: "pending", payment_status: "pending_payment", amount_paid: 500, created_at: T, ...attribution });
    });

    it("counts the two paid orders and neither of the three unpaid ones", async () => {
      const { rows } = await client.query(`select orders, net_revenue, refunds from ad_creative_roas_daily where platform='reddit'`);
      expect(Number(rows[0].orders)).toBe(2);
      // 200 + (100 - 40) = 260. Not 1,760, which is what the three unpaid
      // orders would add.
      expect(Number(rows[0].net_revenue)).toBe(260);
      expect(Number(rows[0].refunds)).toBe(40);
    });

    it("nets an over-refund negative rather than clamping it at zero", async () => {
      // Clamping would disagree with the ledger exactly where the store lost
      // money — the direction that flatters.
      await client.query(`update orders set refund_amount = 300 where order_id = 'paid'`);
      const { rows } = await client.query(`select net_revenue from ad_creative_roas_daily where platform='reddit'`);
      expect(Number(rows[0].net_revenue)).toBe(-40); // (200-300) + (100-40)
      await client.query(`update orders set refund_amount = 0 where order_id = 'paid'`);
    });
  });

  // -------------------------------------------------------------------------
  // A REFUND CHANGES THE STATUS, AND THE STATUS FILTER HAD NOT BEEN TOLD
  // -------------------------------------------------------------------------

  describe("an order that took money and then gave some back", () => {
    // payment-webhook.ts moves a refunded order OUT of 'paid': 'refunded' on a
    // full refund, and 'partially_refunded' when the cumulative refund is less
    // than amount_paid (two-step refunds — goods, then shipping — are ordinary
    // practice here). `payment_status = 'paid'` was the whole filter, so the
    // moment any money went back the order left every ROAS view: a PARTIAL
    // refund dropped the WHOLE order's revenue although the store kept most of
    // it, and a FULL refund deleted the evidence rather than showing it,
    // because `refunds` went to zero as well.
    beforeAll(async () => {
      await reset();
      await addSpend([{ platform: "reddit", ad_id: "rr", stat_date: D, utm_content: "hook_ref", utm_campaign: "c", spend: 50, clicks: 10, impressions: 500 }]);
      const attribution = { last_utm_source: "reddit", last_utm_campaign: "c", last_utm_content: "hook_ref" };
      await addOrder({ order_id: "kept-all", payment_status: "paid", amount_paid: 100, created_at: T, ...attribution });
      await addOrder({ order_id: "kept-most", payment_status: "partially_refunded", amount_paid: 100, refund_amount: 30, created_at: T, ...attribution });
      await addOrder({ order_id: "kept-none", payment_status: "refunded", amount_paid: 100, refund_amount: 100, created_at: T, ...attribution });
      await addOrder({ order_id: "never-paid", payment_status: "payment_failed", amount_paid: 100, created_at: T, ...attribution });
    });

    it("keeps the money the store actually kept", async () => {
      const { rows } = await client.query(`select orders, net_revenue, refunds from ad_creative_roas_daily where utm_content='hook_ref'`);
      // 100 + (100-30) + (100-100) = 170. Under the old filter this was 100 —
      // the partial refund's $70 vanished with it.
      expect(Number(rows[0].net_revenue)).toBe(170);
      expect(Number(rows[0].refunds)).toBe(130);
    });

    it("still counts a refunded order as the conversion the ad produced", async () => {
      // Which is how the platforms count it, so CPA and CVR stay comparable
      // with what Meta and TikTok report. The money truth is net_revenue.
      const { rows } = await client.query(`select orders, round(cpa,4) cpa from ad_creative_roas_daily where utm_content='hook_ref'`);
      expect(Number(rows[0].orders)).toBe(3);
      expect(Number(rows[0].cpa)).toBeCloseTo(50 / 3, 4);
    });

    it("still refuses an order in which no money was ever taken", async () => {
      const { rows } = await client.query(`select orders from ad_creative_roas_daily where utm_content='hook_ref'`);
      expect(Number(rows[0].orders), "payment_failed must stay out").toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // THE TWO SIDES OF THE JOIN WERE NORMALISED DIFFERENTLY
  // -------------------------------------------------------------------------

  describe("a tag spelled in mixed case still matches its spend", () => {
    // parseAdTagsFromUrl reads the tags back out of the ad's destination URL
    // and lowercases every value, so ad_spend_daily.utm_content is always
    // lowercase. The ORDER side stores what the browser saw, untouched. An ad
    // built by hand in Meta Ads Manager with `utm_content=Hook_A` therefore
    // produced a spend row keyed `hook_a` against orders keyed `Hook_A`, the
    // join found nothing, and that ad reported ROAS 0.00 with its revenue in
    // none of the blind-spot views either.
    beforeAll(async () => {
      await reset();
      await addSpend([{ platform: "facebook", ad_id: "mc1", stat_date: D, utm_content: "hook_case", utm_campaign: "camp_case", spend: 50, clicks: 100, impressions: 2000 }]);
      await addOrder({ order_id: "upper", amount_paid: 100, created_at: T, last_utm_source: "Facebook", last_utm_campaign: "Camp_Case", last_utm_content: "Hook_Case" });
      await addOrder({ order_id: "shouty", amount_paid: 100, created_at: T, last_utm_source: "FACEBOOK", last_utm_campaign: "CAMP_CASE", last_utm_content: "HOOK_CASE" });
      await addOrder({ order_id: "lower", amount_paid: 100, created_at: T, last_utm_source: "facebook", last_utm_campaign: "camp_case", last_utm_content: "hook_case" });
    });

    it("collapses every spelling into one creative row and matches the spend", async () => {
      const { rows } = await client.query(`select utm_content, orders, net_revenue, round(roas,4) roas from ad_creative_roas_daily where platform='facebook'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].utm_content).toBe("hook_case");
      expect(Number(rows[0].orders)).toBe(3);
      expect(Number(rows[0].net_revenue)).toBe(300);
      expect(Number(rows[0].roas)).toBe(6); // 300 / 50
    });

    it("does the same at the campaign grain", async () => {
      const { rows } = await client.query(`select utm_campaign, orders, net_revenue from ad_campaign_daily where platform='facebook'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].utm_campaign).toBe("camp_case");
      expect(Number(rows[0].net_revenue)).toBe(300);
    });

    it("leaves nothing behind in the unattributed view", async () => {
      const { rows } = await client.query(`select coalesce(sum(net_revenue),0) leaked from ad_revenue_unattributed`);
      expect(Number(rows[0].leaked)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // THE SALE LANDS THE DAY AFTER THE CLICK
  // -------------------------------------------------------------------------

  describe("revenue on a day the ad did not spend", () => {
    // Revenue arrives on the day of the ORDER; spend on the day of the CLICK.
    // They are routinely different days — a click at 23:00 that converts at
    // 00:30, an ad paused mid-flight that keeps converting, or the offset
    // between the ad account's reporting day and UTC. A LEFT join from spend
    // had no row to attach that revenue to and dropped it silently, so an ad
    // returning 4x reported ROAS 0.00 and, because Winners and Losers are
    // ranked by ROAS, was presented to the owner as the store's worst ad.
    beforeAll(async () => {
      await reset();
      await addSpend([{ platform: "reddit", ad_id: "lag", stat_date: "2026-08-20", utm_content: "lag_hook", utm_campaign: "lag_c", spend: 100, clicks: 200, impressions: 5000 }]);
      await addOrder({
        order_id: "lagged", amount_paid: 400, created_at: "2026-08-21T10:00:00Z",
        last_utm_source: "reddit", last_utm_campaign: "lag_c", last_utm_content: "lag_hook",
      });
    });

    it("keeps the sale at the creative grain, on its own day", async () => {
      const { rows } = await client.query(
        `select stat_date::text, spend, orders, net_revenue, roas from ad_creative_roas_daily where utm_content='lag_hook' order by stat_date`,
      );
      expect(rows).toHaveLength(2);
      expect(Number(rows[0].spend)).toBe(100);
      expect(Number(rows[0].net_revenue)).toBe(0);
      expect(Number(rows[1].spend)).toBe(0);
      expect(Number(rows[1].net_revenue)).toBe(400);
    });

    it("reports ROAS as unknown on a day with no spend, never as a division by zero", async () => {
      const { rows } = await client.query(
        `select roas, cpa, ctr, cpc, cpm, cvr from ad_creative_roas_daily where utm_content='lag_hook' and spend = 0`,
      );
      for (const key of ["roas", "cpa", "ctr", "cpc", "cpm", "cvr"]) {
        expect(rows[0][key], `${key} on a no-spend day`).toBeNull();
      }
    });

    it("keeps it at the campaign grain too", async () => {
      const { rows } = await client.query(
        `select coalesce(sum(spend),0) spend, coalesce(sum(net_revenue),0) revenue from ad_campaign_daily where utm_campaign='lag_c'`,
      );
      expect(Number(rows[0].spend)).toBe(100);
      expect(Number(rows[0].revenue)).toBe(400);
    });

    it("agrees with the platform grain, which already full-joined", async () => {
      const creative = await client.query(`select coalesce(sum(net_revenue),0) r from ad_creative_roas_daily where platform='reddit'`);
      const platform = await client.query(`select coalesce(sum(net_revenue),0) r from ad_platform_daily where platform='reddit'`);
      expect(Number(creative.rows[0].r)).toBe(Number(platform.rows[0].r));
    });

    it("sums to the truth across the window: 400 against 100 is 4x", async () => {
      const { rows } = await client.query(
        `select sum(spend) spend, sum(net_revenue) revenue from ad_creative_roas_daily where utm_content='lag_hook'`,
      );
      expect(Number(rows[0].revenue) / Number(rows[0].spend)).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // LEAKAGE
  // -------------------------------------------------------------------------

  describe("revenue cannot leak across platform, campaign or creative", () => {
    beforeAll(async () => {
      await reset();
      // The SAME creative tag and campaign tag running on two platforms, with
      // revenue attributed to only one of them.
      await addSpend([
        { platform: "tiktok", ad_id: "t1", stat_date: D, utm_content: "shared", utm_campaign: "shared_c", spend: 100, clicks: 10, impressions: 100 },
        { platform: "facebook", ad_id: "f1", stat_date: D, utm_content: "shared", utm_campaign: "shared_c", spend: 100, clicks: 10, impressions: 100 },
        // A second creative on the same platform and campaign.
        { platform: "tiktok", ad_id: "t2", stat_date: D, utm_content: "other", utm_campaign: "shared_c", spend: 100, clicks: 10, impressions: 100 },
      ]);
      await addOrder({
        order_id: "only-tiktok-shared", amount_paid: 500, created_at: T,
        last_utm_source: "tiktok", last_utm_campaign: "shared_c", last_utm_content: "shared",
      });
    });

    it("credits only the platform that earned it", async () => {
      const { rows } = await client.query(
        `select platform, net_revenue from ad_creative_roas_daily where utm_content='shared' order by platform`,
      );
      const byPlatform = Object.fromEntries(rows.map((r) => [r.platform, Number(r.net_revenue)]));
      expect(byPlatform.tiktok).toBe(500);
      expect(byPlatform.facebook).toBe(0);
    });

    it("credits only the creative that earned it", async () => {
      const { rows } = await client.query(
        `select utm_content, net_revenue from ad_creative_roas_daily where platform='tiktok' order by utm_content`,
      );
      const byCreative = Object.fromEntries(rows.map((r) => [r.utm_content, Number(r.net_revenue)]));
      expect(byCreative.shared).toBe(500);
      expect(byCreative.other).toBe(0);
    });

    it("does not double the campaign total by summing both its creatives' credit", async () => {
      const { rows } = await client.query(`select net_revenue, spend from ad_campaign_daily where platform='tiktok'`);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].net_revenue)).toBe(500);
      expect(Number(rows[0].spend)).toBe(200);
    });

    it("maps every spelling of a platform onto one key before joining", async () => {
      // Spend says `facebook`; a tag might say `meta`, `FB` or `Instagram`.
      // Without ad_platform_key() these join to nothing and the campaign reads
      // as unattributed.
      const { rows } = await client.query(
        `select ad_platform_key('meta') a, ad_platform_key('FB') b,
                ad_platform_key('Instagram') c, ad_platform_key('  SNAP ') d,
                ad_platform_key('') e, ad_platform_key('pinterest') f`,
      );
      expect(rows[0]).toMatchObject({ a: "facebook", b: "facebook", c: "facebook", d: "snapchat", e: null, f: "pinterest" });
    });
  });

  // -------------------------------------------------------------------------
  // THE BLIND SPOTS
  // -------------------------------------------------------------------------

  describe("untagged spend and unattributed revenue are surfaced, not dropped", () => {
    beforeAll(async () => {
      await reset();
      await addSpend([
        { platform: "snapchat", ad_id: "s1", stat_date: D, spend: 40, clicks: 5, impressions: 200 },
        { platform: "tiktok", ad_id: "t9", stat_date: D, landing_url: "https://x.test/p", spend: 60, clicks: 5, impressions: 200 },
      ]);
      await addOrder({ order_id: "no-creative", amount_paid: 90, created_at: T, last_utm_source: "snapchat", last_utm_campaign: "c" });
    });

    it("names untagged spend with the reason it cannot be measured", async () => {
      const { rows } = await client.query(`select platform, spend, reason from ad_spend_untagged order by platform`);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ platform: "snapchat", reason: "no_landing_url_from_platform" });
      expect(rows[1]).toMatchObject({ platform: "tiktok", reason: "landing_url_carries_no_utm_content" });
    });

    it("still counts untagged spend in the platform total", async () => {
      // The spend is real. Only its attribution is missing, and hiding the money
      // would understate cost and flatter ROAS.
      const { rows } = await client.query(`select sum(spend)::numeric total from ad_platform_daily`);
      expect(Number(rows[0].total)).toBe(100);
    });

    it("surfaces revenue that names a platform but no creative", async () => {
      const { rows } = await client.query(`select platform, orders, net_revenue from ad_revenue_unattributed`);
      expect(rows).toHaveLength(1);
      expect(rows[0].platform).toBe("snapchat");
      expect(Number(rows[0].net_revenue)).toBe(90);
    });

    it("keeps that revenue in the platform total and out of every creative", async () => {
      const platform = await client.query(`select net_revenue from ad_platform_daily where platform='snapchat'`);
      expect(Number(platform.rows[0].net_revenue)).toBe(90);
      const creative = await client.query(`select count(*)::int n from ad_creative_roas_daily`);
      expect(creative.rows[0].n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // IDEMPOTENCE AND RE-RUNNABILITY
  // -------------------------------------------------------------------------

  describe("the migration and the ingest are both safe to repeat", () => {
    it("re-runs the whole shipped file with no error and no change in results", async () => {
      await reset();
      await addSpend([{ platform: "tiktok", ad_id: "x1", stat_date: D, utm_content: "k", utm_campaign: "c", spend: 10, clicks: 1, impressions: 10 }]);
      const before = await client.query(`select * from ad_platform_daily`);
      await client.query(shippedSql());
      await client.query(shippedSql());
      const after = await client.query(`select * from ad_platform_daily`);
      expect(after.rows).toEqual(before.rows);
    }, 60_000);

    it("upserts repeated ingestion instead of accumulating it", async () => {
      await reset();
      const row = { platform: "tiktok", ad_id: "dup", stat_date: D, utm_content: "k", utm_campaign: "c", spend: 25, clicks: 4, impressions: 400 };
      // The trailing-window re-fetch does this every single run.
      for (let i = 0; i < 5; i += 1) {
        await client.query(
          `insert into ad_spend_daily (platform, ad_id, stat_date, utm_content, utm_campaign, spend, clicks, impressions)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (platform, ad_id, stat_date) do update set
             spend = excluded.spend, clicks = excluded.clicks, impressions = excluded.impressions`,
          [row.platform, row.ad_id, row.stat_date, row.utm_content, row.utm_campaign, row.spend, row.clicks, row.impressions],
        );
      }
      const { rows } = await client.query(`select count(*)::int n, sum(spend)::numeric s, sum(clicks)::numeric c from ad_spend_daily`);
      // One row, $25 — not five rows and $125.
      expect(rows[0].n).toBe(1);
      expect(Number(rows[0].s)).toBe(25);
      expect(Number(rows[0].c)).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // PLATFORM COUNTS STAY OUT OF OUR ARITHMETIC
  // -------------------------------------------------------------------------

  it("never lets the platform's own conversion count reach ROAS, CPA or CVR", async () => {
    await reset();
    await addSpend([{
      platform: "facebook", ad_id: "p1", stat_date: D, utm_content: "k", utm_campaign: "c",
      spend: 100, clicks: 100, impressions: 1000,
      // The platform claims 40 purchases. We recorded one.
      platform_conversions: 40,
    }]);
    await addOrder({ order_id: "one", amount_paid: 50, created_at: T, last_utm_source: "facebook", last_utm_campaign: "c", last_utm_content: "k" });

    const { rows } = await client.query(
      `select platform_conversions, orders, cpa, cvr, roas from ad_creative_roas_daily where platform='facebook'`,
    );
    expect(Number(rows[0].platform_conversions)).toBe(40);
    expect(Number(rows[0].orders)).toBe(1);
    // All three derive from OUR one order, never from the platform's forty.
    expect(Number(rows[0].cpa)).toBe(100);
    expect(Number(rows[0].cvr)).toBeCloseTo(0.01, 9);
    expect(Number(rows[0].roas)).toBeCloseTo(0.5, 9);
  });

  it("computes CPM, CPC and CTR from the summed parts", async () => {
    await reset();
    await addSpend([
      { platform: "tiktok", ad_id: "m1", stat_date: D, utm_content: "k", utm_campaign: "c", spend: 30, clicks: 20, impressions: 10000 },
      { platform: "tiktok", ad_id: "m2", stat_date: D, utm_content: "k", utm_campaign: "c", spend: 70, clicks: 30, impressions: 15000 },
    ]);
    const { rows } = await client.query(`select spend, clicks, impressions, cpc, cpm, ctr from ad_creative_roas_daily`);
    expect(Number(rows[0].spend)).toBe(100);
    expect(Number(rows[0].clicks)).toBe(50);
    expect(Number(rows[0].impressions)).toBe(25000);
    expect(Number(rows[0].cpc)).toBeCloseTo(2, 9); // 100/50
    expect(Number(rows[0].cpm)).toBeCloseTo(4, 9); // 100/25000*1000
    expect(Number(rows[0].ctr)).toBeCloseTo(0.002, 9); // 50/25000
  });

  // ---------------------------------------------------------------------------
  // ONE ORDER IS ONE CHANNEL'S REVENUE.
  //
  // marketing-source.ts decides a single primary channel per order precisely so
  // "$150 of campaign revenue AND $150 of automation revenue AND $150
  // recovered" cannot happen. The email dashboard honours it. These views did
  // not mention it, so an ad click that did not convert followed weeks later by
  // a campaign-email click that did was counted in full on BOTH tabs — and with
  // a 30-day attribution window that is the ordinary repeat purchase, not a
  // corner case. Live budget decisions were made on the inflated ROAS.
  // ---------------------------------------------------------------------------
  describe("revenue another channel has already claimed", () => {
    beforeEach(reset);

    it.each([
      ["a campaign email", "campaign"],
      ["an automation", "automation"],
      ["cart recovery", "cart_recovery"],
    ])("is not also counted as ad revenue when %s owns the order", async (_label, kind) => {
      await addSpend([{ platform: "tiktok", ad_id: "a1", stat_date: D, spend: 50, utm_source: "tiktok", utm_campaign: "launch", utm_content: "hook_a" }]);
      await addOrder({
        order_id: "o1", amount_paid: 150, created_at: T, marketing_source_kind: kind,
        last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a",
      });

      const { rows } = await client.query("select coalesce(sum(net_revenue),0)::float8 as revenue from ad_revenue_daily");
      expect(rows[0].revenue).toBe(0);
    });

    it("still counts an order the ads pipeline owns", async () => {
      await addOrder({
        order_id: "o1", amount_paid: 150, created_at: T, marketing_source_kind: "ad",
        last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a",
      });

      const { rows } = await client.query("select coalesce(sum(net_revenue),0)::float8 as revenue from ad_revenue_daily");
      expect(rows[0].revenue).toBe(150);
    });

    it("still counts an order with no stamp at all, so nothing is lost while it backfills", async () => {
      await addOrder({
        order_id: "o1", amount_paid: 150, created_at: T,
        last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a",
      });

      const { rows } = await client.query("select coalesce(sum(net_revenue),0)::float8 as revenue from ad_revenue_daily");
      expect(rows[0].revenue).toBe(150);
    });

    it("still counts an ambassador-attributed order, which is left as an owner decision", async () => {
      // The rule ranks a typed referral code above an ad touch, but the
      // ambassador's commission is a separate ledger and an ad that paid for
      // the click onto their link produced a real ad-driven sale. Which side
      // carries the revenue is a tagging-policy call, not one for a view.
      await addOrder({
        order_id: "o1", amount_paid: 150, created_at: T, marketing_source_kind: "ambassador",
        last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a",
      });

      const { rows } = await client.query("select coalesce(sum(net_revenue),0)::float8 as revenue from ad_revenue_daily");
      expect(rows[0].revenue).toBe(150);
    });

    it("keeps the ROAS honest end to end: $50 spend, one campaign-owned order, no revenue", async () => {
      await addSpend([{ platform: "tiktok", ad_id: "a1", stat_date: D, spend: 50, utm_source: "tiktok", utm_campaign: "launch", utm_content: "hook_a" }]);
      await addOrder({
        order_id: "o1", amount_paid: 150, created_at: T, marketing_source_kind: "campaign",
        last_utm_source: "tiktok", last_utm_campaign: "launch", last_utm_content: "hook_a",
      });

      const { rows } = await client.query(
        "select spend::float8 as spend, net_revenue::float8 as net_revenue, roas::float8 as roas from ad_creative_roas_daily",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].spend).toBe(50);
      expect(rows[0].net_revenue).toBe(0);
      expect(rows[0].roas, "3.0 before the fix — three times the truth").toBe(0);
    });
  });
});
