import { supabaseAdmin } from "@/lib/supabase-server";
import { businessDayKey, startOfBusinessDay, startOfBusinessDayIso } from "@/lib/business-day";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";

const ONLINE_WINDOW_MINUTES = 5;

function onlineWindowStartIso() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - ONLINE_WINDOW_MINUTES);
  return date.toISOString();
}

export async function getCurrentOnlineVisitorCount() {
  const { data, error } = await supabaseAdmin
    .from("website_analytics_events")
    .select("session_id")
    .gte("created_at", onlineWindowStartIso())
    .in("event_type", ["session_start", "page_view"])
    .not("session_id", "is", null)
    // A CEILING ON MEMORY, NOT A GUARANTEE OF EXACTNESS. PostgREST's
    // `db-max-rows` (Supabase ships it at 1,000 — see supabase-page.ts) caps
    // every response regardless of what is asked for, so the real ceiling on
    // this read is that setting, not this number, and a larger literal would
    // buy headroom that does not exist. Unlike the money reads this one is not
    // paged: an exact distinct count needs a `count(distinct session_id)` RPC,
    // and a five-minute window of session_start/page_view rows has never come
    // near either bound.
    .limit(5000);

  if (error) {
    throw error;
  }

  const sessions = new Set<string>();
  for (const row of data ?? []) {
    if (row.session_id) {
      sessions.add(String(row.session_id));
    }
  }

  return sessions.size;
}

// ONE DEFINITION, AND IT IS THE STORE'S DAY — NOT THE SERVER'S, NOT UTC'S.
//
// This used to read `setHours(0,0,0,0)` (the server's zone) and was pinned to
// UTC to match admin-revenue.getRevenueMetrics and
// admin-profit.getProfitWindowMetrics, so that two tiles on one dashboard could
// not disagree. Half right: sharing one definition is the point, but UTC is not
// the day this store trades in. Midnight UTC is 8pm ET, so every evening
// "today" rolled into tomorrow and the day's figures fell out of the tile —
// while the timestamps rendered beside them, which format-date.ts puts in
// America/New_York, still said today. business-day.ts is now that one
// definition, in the zone the rest of the admin already displays.
function dayStartIso() {
  return startOfBusinessDayIso();
}

function daysAgoIso(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

// Delegate to the canonical predicate so every dashboard shares one definition.
//
// isRevenueOrderStatus, NOT isPaidOrderStatus (review finding 4). The two differ
// by exactly `partially_refunded`, and this surface used the narrower one — so a
// $200 order refunded by $50 was $150 on the revenue page and $0 here, on
// dashboards an operator reads side by side. `isSaleOrder` is the second half:
// a replacement is an outbound reship the store paid for, with amount_paid 0, so
// it adds nothing to revenue and only pads the order count.
function countsAsRevenue(row: { payment_status?: unknown; order_type?: unknown }) {
  return isRevenueOrderStatus(row.payment_status as string | null | undefined)
    && isSaleOrder(row.order_type as string | null | undefined);
}

type RevenueRow = {
  amount_paid: number | null;
  refund_amount: number | null;
  payment_status: string | null;
  order_type: string | null;
  paid_at: string | null;
  created_at: string | null;
};

export type RevenueTrendPoint = {
  date: string;
  amount: number;
};

type RevenueRangeInput = {
  fromIso: string;
  toIso: string;
};

function revenueFromRows(rows: RevenueRow[]) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const dayStart = new Date(dayStartIso()).getTime();
  const weekStart = now - 7 * oneDay;
  const monthStart = now - 30 * oneDay;

  let today = 0;
  let last7Days = 0;
  let last30Days = 0;

  for (const row of rows) {
    if (!countsAsRevenue(row)) {
      continue;
    }

    const amount = netOrderRevenue(row);
    // NON-FINITE ONLY. This used to skip `amount <= 0`, which silently DROPPED
    // an over-refunded order (net revenue below zero) while /admin/revenue
    // summed it — reintroducing, on this one surface, exactly the disagreement
    // ledger.netOrderRevenue's signed convention exists to remove. A zero adds
    // nothing to a sum, so nothing else changes.
    if (!Number.isFinite(amount)) {
      continue;
    }

    const eventTime = Date.parse(row.paid_at ?? row.created_at ?? "");
    if (!Number.isFinite(eventTime)) {
      continue;
    }

    if (eventTime >= dayStart) {
      today += amount;
    }
    if (eventTime >= weekStart) {
      last7Days += amount;
    }
    if (eventTime >= monthStart) {
      last30Days += amount;
    }
  }

  return {
    today,
    last7Days,
    last30Days,
  };
}

const REVENUE_COLUMNS = "amount_paid, refund_amount, payment_status, order_type, paid_at, created_at";

// Ceiling on one read, not a definition of the answer — the same one
// admin-revenue.ts puts on its fallback aggregation.
const MAX_REVENUE_ORDERS = 200_000;

// PAGED, LIKE EVERY OTHER READ THAT FEEDS A MONEY FIGURE.
//
// These four selects carried no `.range()` and no `.limit()`, which is not the
// same as unbounded: PostgREST caps every response at its `db-max-rows`
// (Supabase's default is 1,000) and says nothing when it does. admin-profit.ts
// records reproducing exactly that — 1,500 orders against a 1,000-row cap
// reported a third less money with no error and no warning — and every other
// financial read on this branch (admin-profit, admin-revenue, admin-tax-report)
// pages to exhaustion for it. These two functions were the last that did not,
// and they feed the "Revenue · 30d" tile on /admin and the metrics API.
//
// `.order("id")` is the deterministic tiebreak paging needs; paid_at and
// created_at are not unique, so ordering on those alone could repeat or skip
// rows between pages.
function revenueSelect() {
  return supabaseAdmin.from("orders").select(REVENUE_COLUMNS);
}

function pageRevenueRows(
  build: (query: ReturnType<typeof revenueSelect>) => ReturnType<typeof revenueSelect>,
  label: string,
) {
  return readAllRowsBounded<RevenueRow>(
    (from, to) =>
      build(revenueSelect())
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: RevenueRow[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_REVENUE_ORDERS, label },
  );
}

export async function getRevenueWindowMetrics() {
  const monthStartIso = daysAgoIso(30);

  const [paid, fallback] = await Promise.all([
    pageRevenueRows((q) => q.gte("paid_at", monthStartIso), "revenue window read"),
    pageRevenueRows((q) => q.is("paid_at", null).gte("created_at", monthStartIso), "revenue window fallback read"),
  ]);

  return {
    ...revenueFromRows([...paid.rows, ...fallback.rows]),
    // Reported, not absorbed: a smaller number presented as the whole story is
    // the failure mode the pager exists to end. /admin renders it next to the
    // profit report's own flag.
    truncated: paid.truncated || fallback.truncated,
  };
}

async function getRevenueRowsInRange(input: RevenueRangeInput) {
  const [paid, fallback] = await Promise.all([
    pageRevenueRows((q) => q.gte("paid_at", input.fromIso).lte("paid_at", input.toIso), "revenue trend read"),
    pageRevenueRows(
      (q) => q.is("paid_at", null).gte("created_at", input.fromIso).lte("created_at", input.toIso),
      "revenue trend fallback read",
    ),
  ]);

  return [...paid.rows, ...fallback.rows];
}

// The trend's buckets are the same days the tiles above it count, so a 9pm ET
// sale lands on tonight's bar rather than tomorrow's. Bucketing on the UTC date
// slice put it a day forward, which made the chart's last bar and the "today"
// tile on the same dashboard disagree about the same order.
function iterateDays(fromIso: string, toIso: string) {
  const points: string[] = [];
  const end = startOfBusinessDay(new Date(toIso));
  let cursor = startOfBusinessDay(new Date(fromIso));

  while (cursor.getTime() <= end.getTime()) {
    points.push(businessDayKey(cursor));
    cursor = startOfBusinessDay(cursor, 1);
  }

  return points;
}

export async function getRevenueTrend(input: RevenueRangeInput) {
  const rows = await getRevenueRowsInRange(input);
  const dayTotals = new Map<string, number>();

  for (const day of iterateDays(input.fromIso, input.toIso)) {
    dayTotals.set(day, 0);
  }

  for (const row of rows) {
    if (!countsAsRevenue(row)) {
      continue;
    }

    const amount = netOrderRevenue(row);
    // NON-FINITE ONLY. This used to skip `amount <= 0`, which silently DROPPED
    // an over-refunded order (net revenue below zero) while /admin/revenue
    // summed it — reintroducing, on this one surface, exactly the disagreement
    // ledger.netOrderRevenue's signed convention exists to remove. A zero adds
    // nothing to a sum, so nothing else changes.
    if (!Number.isFinite(amount)) {
      continue;
    }

    const timestamp = row.paid_at ?? row.created_at;
    if (!timestamp) {
      continue;
    }

    const day = businessDayKey(new Date(timestamp));
    dayTotals.set(day, (dayTotals.get(day) ?? 0) + amount);
  }

  return Array.from(dayTotals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date, amount }));
}
