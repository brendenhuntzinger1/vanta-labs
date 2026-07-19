import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { createPartnerInvite, getAdminPartnerRows } from "@/lib/partner-portal";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "admin") {
    return unauthorizedResponse();
  }

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const status = url.searchParams.get("status") ?? "all";

  try {
    const rows = await getAdminPartnerRows({ search, status });
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load partners";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "admin") {
    return unauthorizedResponse();
  }

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
      createdByUserId: user.id,
    });

    return NextResponse.json({ success: true, invite });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to invite partner";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
