import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";

/**
 * "Am I signed in?" — a question, whose answer may be no.
 *
 * This used to answer 401 when the answer was no. The body already said
 * `{"authenticated": false}`, so the status carried nothing the caller did not
 * already have; what it carried instead was a red console error on every
 * anonymous visit to /vault, and a line in production's 401 breakdown on an
 * ADMIN auth path that reads exactly like a real refusal. That is the same
 * defect the customer sign-in portal was cleared of earlier in this audit, for
 * the same reason: a probe that always fails for the visitor who has not signed
 * in yet teaches whoever reads the logs to ignore the one signal that means
 * something is actually wrong.
 *
 * The boundary does not live here and has not moved: it is
 * verifyAdminSessionFromCookie, and no admin data crosses this route either
 * way. `no-store` on both answers, because both depend on who asked.
 */
export async function GET() {
  const session = await verifyAdminSessionFromCookie();

  return NextResponse.json(
    session ? { authenticated: true, username: session.username } : { authenticated: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
