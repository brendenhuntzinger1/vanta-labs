import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getCurrentOnlineVisitorCount, getRevenueTrend, getRevenueWindowMetrics } from "@/lib/admin-analytics";
import { endOfBusinessDay, startOfBusinessDate, startOfBusinessDay } from "@/lib/business-day";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

// Every preset spans WHOLE STORE DAYS (business-day.ts). Cut at midnight UTC,
// "today" started at 8pm the previous evening ET and ended at 8pm tonight, so
// the range the operator picked was never the range they got.
function resolveRange(url: URL) {
  const preset = url.searchParams.get("preset") ?? "7d";
  const now = new Date();
  const to = endOfBusinessDay(now);

  const daysBack = (n: number) => startOfBusinessDay(now, -n);

  if (preset === "custom") {
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const fromParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromParam ?? "");
    const toParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toParam ?? "");
    if (fromParts && toParts) {
      // The picker sends the store's calendar dates, so they resolve to the
      // store's midnights — not to whatever instant those dates name in UTC.
      const fromDate = startOfBusinessDate(Number(fromParts[1]), Number(fromParts[2]), Number(fromParts[3]));
      const toDate = new Date(
        startOfBusinessDate(Number(toParts[1]), Number(toParts[2]), Number(toParts[3]) + 1).getTime() - 1,
      );
      if (Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime()) && fromDate <= toDate) {
        return {
          preset,
          fromIso: fromDate.toISOString(),
          toIso: toDate.toISOString(),
        };
      }
    }
  }

  const from =
    preset === "today" ? daysBack(0)
    : preset === "30d" ? daysBack(29)
    : preset === "90d" ? daysBack(89)
    : daysBack(6);

  return {
    preset,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const url = new URL(request.url);
    const range = resolveRange(url);

    const [onlineNow, revenue, trend] = await Promise.all([
      getCurrentOnlineVisitorCount(),
      getRevenueWindowMetrics(),
      getRevenueTrend({ fromIso: range.fromIso, toIso: range.toIso }),
    ]);

    const rangeTotal = trend.reduce((sum, point) => sum + point.amount, 0);

    return NextResponse.json(
      {
        success: true,
        metrics: {
          onlineNow,
          revenue,
          selectedRange: {
            preset: range.preset,
            fromIso: range.fromIso,
            toIso: range.toIso,
            total: rangeTotal,
            trend,
          },
          updatedAt: new Date().toISOString(),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load metrics";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
