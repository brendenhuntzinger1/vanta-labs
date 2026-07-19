import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";

export async function GET() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    return NextResponse.json({ authenticated: false }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return NextResponse.json(
    { authenticated: true, username: session.username },
    { headers: { "Cache-Control": "no-store" } },
  );
}
