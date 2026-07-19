import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getCurrentOnlineVisitorCount, getRevenueTrend, getRevenueWindowMetrics } from "@/lib/admin-analytics";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function resolveRange(url: URL) {
  const preset = url.searchParams.get("preset") ?? "7d";
  const now = new Date();
  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);

  const from = new Date(now);

  if (preset === "today") {
    from.setUTCHours(0, 0, 0, 0);
  } else if (preset === "30d") {
    from.setUTCDate(from.getUTCDate() - 29);
    from.setUTCHours(0, 0, 0, 0);
  } else if (preset === "90d") {
    from.setUTCDate(from.getUTCDate() - 89);
    from.setUTCHours(0, 0, 0, 0);
  } else if (preset === "custom") {
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    if (fromParam && toParam) {
      const fromDate = new Date(`${fromParam}T00:00:00.000Z`);
      const toDate = new Date(`${toParam}T23:59:59.999Z`);
      if (Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime()) && fromDate <= toDate) {
        return {
          preset,
          fromIso: fromDate.toISOString(),
          toIso: toDate.toISOString(),
        };
      }
    }
    from.setUTCDate(from.getUTCDate() - 6);
    from.setUTCHours(0, 0, 0, 0);
  } else {
    from.setUTCDate(from.getUTCDate() - 6);
    from.setUTCHours(0, 0, 0, 0);
  }

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
