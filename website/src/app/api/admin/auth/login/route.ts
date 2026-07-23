import { NextResponse } from "next/server";
import {
  buildAdminSessionCookie,
  canAttemptAdminLogin,
  createAdminSession,
  getRequestIpAddress,
  getRequestUserAgent,
  recordAdminLoginAttempt,
  validateAdminCredentials,
  verifyAdminPasscode,
} from "@/lib/admin-auth";

// A single generic message for every credential/passcode failure so an
// attacker can't tell which of the three factors (username, password,
// passcode) was correct.
const INVALID_MESSAGE = "Invalid username, password, or passcode.";

export async function POST(request: Request) {
  let payload: { username?: string; password?: string; passcode?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = (payload.username ?? "").trim().toLowerCase();
  const password = payload.password ?? "";
  const passcode = payload.passcode ?? "";
  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

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
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  // Second factor: 6-digit passcode (per-account, or ADMIN_ACCESS_CODE
  // fallback). A wrong passcode counts as a failed attempt toward lockout.
  const passcodeStatus = verifyAdminPasscode(user, passcode);
  if (passcodeStatus === "invalid") {
    await recordAdminLoginAttempt({ username, ipAddress, userAgent, success: false });
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  await recordAdminLoginAttempt({ username, ipAddress, userAgent, success: true });

  const token = await createAdminSession({
    username: user.username,
    ipAddress,
    userAgent,
  });

  const response = NextResponse.json({ ok: true, passcodeConfigured: passcodeStatus === "ok" });
  response.headers.set("Cache-Control", "no-store");
  const cookie = buildAdminSessionCookie(token);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
