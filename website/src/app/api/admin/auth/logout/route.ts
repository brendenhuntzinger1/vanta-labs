import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  buildExpiredAdminSessionCookie,
  destroyAdminSession,
} from "@/lib/admin-auth";

export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));

  const token = sessionCookie ? decodeURIComponent(sessionCookie.split("=").slice(1).join("=")) : null;

  await destroyAdminSession(token);

  const response = NextResponse.json({ ok: true });
  response.headers.set("Cache-Control", "no-store");
  const expired = buildExpiredAdminSessionCookie();
  response.cookies.set(expired.name, expired.value, expired.options);
  return response;
}
