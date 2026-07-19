import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getCurrentOnlineVisitorCount, getRevenueWindowMetrics } from "@/lib/admin-analytics";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const [onlineNow, revenue] = await Promise.all([
      getCurrentOnlineVisitorCount(),
      getRevenueWindowMetrics(),
    ]);

    return NextResponse.json(
      {
        success: true,
        metrics: {
          onlineNow,
          revenue,
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
