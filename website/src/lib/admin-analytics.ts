import { supabaseAdmin } from "@/lib/supabase-server";

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

function dayStartIso() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function daysAgoIso(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function isPaidStatus(value: unknown) {
  const status = String(value ?? "").toLowerCase();
  return status === "paid" || status === "completed" || status === "succeeded";
}

type RevenueRow = {
  amount_paid: number | null;
  payment_status: string | null;
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
    if (!isPaidStatus(row.payment_status)) {
      continue;
    }

    const amount = Number(row.amount_paid ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
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

export async function getRevenueWindowMetrics() {
  const monthStartIso = daysAgoIso(30);

  const [{ data: paidRows, error: paidError }, { data: fallbackRows, error: fallbackError }] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("amount_paid, payment_status, paid_at, created_at")
      .gte("paid_at", monthStartIso),
    supabaseAdmin
      .from("orders")
      .select("amount_paid, payment_status, paid_at, created_at")
      .is("paid_at", null)
      .gte("created_at", monthStartIso),
  ]);

  if (paidError) {
    throw paidError;
  }

  if (fallbackError) {
    throw fallbackError;
  }

  const allRows = [...(paidRows ?? []), ...(fallbackRows ?? [])] as RevenueRow[];
  return revenueFromRows(allRows);
}

async function getRevenueRowsInRange(input: RevenueRangeInput) {
  const [{ data: paidRows, error: paidError }, { data: fallbackRows, error: fallbackError }] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("amount_paid, payment_status, paid_at, created_at")
      .gte("paid_at", input.fromIso)
      .lte("paid_at", input.toIso),
    supabaseAdmin
      .from("orders")
      .select("amount_paid, payment_status, paid_at, created_at")
      .is("paid_at", null)
      .gte("created_at", input.fromIso)
      .lte("created_at", input.toIso),
  ]);

  if (paidError) {
    throw paidError;
  }

  if (fallbackError) {
    throw fallbackError;
  }

  return [...(paidRows ?? []), ...(fallbackRows ?? [])] as RevenueRow[];
}

function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

function iterateDays(fromIso: string, toIso: string) {
  const points: string[] = [];
  const cursor = new Date(fromIso);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toIso);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    points.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
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
    if (!isPaidStatus(row.payment_status)) {
      continue;
    }

    const amount = Number(row.amount_paid ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const timestamp = row.paid_at ?? row.created_at;
    if (!timestamp) {
      continue;
    }

    const day = timestamp.slice(0, 10);
    dayTotals.set(day, (dayTotals.get(day) ?? 0) + amount);
  }

  return Array.from(dayTotals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, amount]) => ({ date, amount }));
}

export async function getDailyProfitEstimate() {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("amount_paid, payment_status, paid_at, created_at")
    .gte("created_at", dayStartIso());

  if (error) {
    throw error;
  }

  return revenueFromRows((data ?? []) as RevenueRow[]).today;
}
