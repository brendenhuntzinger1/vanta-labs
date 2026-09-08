import "server-only";

import type { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  EMAIL_GRANT_COOKIE,
  EMAIL_GRANT_MAX_AGE_SECONDS,
  signEmailLinkGrant,
} from "@/lib/email/link-grant";

/**
 * MAY THIS RECIPIENT BE WAVED PAST THE SIGN-IN WALL?
 *
 * The 21+ and research-use-only representations are collected on the sign-in
 * form, so the wall and the age gate are the same screen. A marketing-link
 * grant skips the wall, which means it would skip the attestation for anyone
 * who has never made it. This is the check that stops that: a grant is minted
 * only for an address whose account already carries both.
 *
 * FAILS CLOSED, AND THAT IS THE WHOLE POINT. Every failure — no account, a
 * missing SQL function, a transport blip, a thrown exception — answers false.
 * False costs a click-through; true for someone who never attested costs the
 * compliance record. Those are not comparable, so the ambiguous cases all go
 * one way.
 *
 * ONE ROUND TRIP, deliberately. findUserByEmail() answers a richer question
 * with an RPC followed by an admin-API fetch, and this runs on a redirect a
 * customer is waiting on. sql/auth-user-attested-by-email.sql exists so the
 * click path pays for one fact once.
 */
export async function recipientHasAttested(email: string): Promise<boolean> {
  const target = String(email ?? "").trim().toLowerCase();
  if (!target) return false;
  try {
    const { data, error } = await supabaseAdmin.rpc("auth_user_attested_by_email", { p_email: target });
    if (error) {
      // Most likely the migration has not been applied. Say so once, loudly
      // enough to be greppable: the symptom otherwise is "marketing clicks
      // still hit the login page", which looks identical to the bug this whole
      // change exists to fix.
      console.error("[email-grant] attestation lookup unavailable; no grant will be minted", error.message);
      return false;
    }
    return data === true;
  } catch {
    return false;
  }
}

/**
 * Attach a marketing-link grant to a redirect, when the recipient has earned
 * one.
 *
 * Takes the response rather than returning a cookie so there is exactly one
 * place that knows the cookie's attributes, and both click trackers set an
 * identical one.
 *
 * NEVER THROWS AND NEVER BLOCKS THE REDIRECT. A customer who clicked a link in
 * an email must reach a page; the worst outcome available here is that they
 * reach the sign-in page, which is what they reached before this existed.
 *
 * Returns whether a grant was attached, purely so a caller can log it.
 */
export async function attachEmailLinkGrant(
  response: NextResponse,
  email: string,
): Promise<boolean> {
  try {
    if (!(await recipientHasAttested(email))) return false;
    const token = await signEmailLinkGrant();
    if (!token) return false;
    response.cookies.set({
      name: EMAIL_GRANT_COOKIE,
      value: token,
      // No script reads a bearer capability.
      httpOnly: true,
      // Lax, not Strict: the customer is arriving from their mail client, which
      // is a cross-site navigation. Strict would withhold the cookie on exactly
      // the request it was minted for.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: EMAIL_GRANT_MAX_AGE_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}
