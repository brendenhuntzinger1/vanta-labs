import { NextResponse } from "next/server";
import {
  buildAdminSessionCookie,
  canAttemptAdminLogin,
  createAdminSession,
  recordAdminLoginAttempt,
  validateAdminCredentials,
} from "@/lib/admin-auth";
import { rateLimitPlaceholder } from "@/lib/rate-limit";

export async function POST(request: Request) {
  rateLimitPlaceholder();

  let payload: { username?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = (payload.username ?? "").trim().toLowerCase();
  const password = payload.password ?? "";
  const ipAddress = request.headers.get("x-forwarded-for") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  const lockout = await canAttemptAdminLogin({ username, ipAddress });
  if (!lockout.allowed) {
    const response = NextResponse.json(
      { error: "Too many failed attempts. Please wait before trying again." },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(lockout.retryAfterSeconds));
    return response;
  }

  const user = await validateAdminCredentials(username, password);
  if (!user) {
    await recordAdminLoginAttempt({ username, ipAddress, userAgent, success: false });
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await recordAdminLoginAttempt({ username, ipAddress, userAgent, success: true });

  const token = await createAdminSession({
    username: user.username,
    ipAddress,
    userAgent,
  });

  const response = NextResponse.json({ ok: true });
  const cookie = buildAdminSessionCookie(token);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
