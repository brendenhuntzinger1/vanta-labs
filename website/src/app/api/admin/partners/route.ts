import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { createPartnerInvite, getAdminPartnerRows } from "@/lib/partner-portal";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const status = url.searchParams.get("status") ?? "all";
  const payoutStatus = url.searchParams.get("payoutStatus") ?? "all";

  try {
    const rows = await getAdminPartnerRows({ search, status, payoutStatus });
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load partners";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  try {
    const body = await request.json();
    const name = String(body?.name ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const commissionPercent = Number(body?.commissionPercent ?? 10);

    if (!name || !email || !email.includes("@")) {
      return NextResponse.json({ success: false, error: "Valid name and email are required" }, { status: 400 });
    }

    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      return NextResponse.json({ success: false, error: "Commission must be between 0 and 100" }, { status: 400 });
    }

    const invite = await createPartnerInvite({
      name,
      email,
      commissionPercent,
      createdByUserId: undefined,
      actorUsername: session.username,
      ipAddress,
      userAgent,
    });

    return NextResponse.json({ success: true, invite });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to invite partner";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
