import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { listCustomerBalances } from "@/lib/admin-membership";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to view membership balances." }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? "";
    const rows = await listCustomerBalances(search);
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load customer balances";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
