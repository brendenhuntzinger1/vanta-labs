import { NextResponse, type NextRequest } from "next/server";
import { verifyAttestationHandoff } from "@/lib/email/attestation-handoff";
import { recordAttestationForEmail } from "@/lib/email/attestation-record";
import {
  EMAIL_GRANT_COOKIE,
  EMAIL_GRANT_MAX_AGE_SECONDS,
  emailGrantAllowsPath,
  signEmailLinkGrant,
} from "@/lib/email/link-grant";
import { OFFER_COOKIE, OFFER_COOKIE_MAX_AGE_SECONDS } from "@/lib/offers/customer-offers";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/**
 * THE ACT. Everything before this is explanation; this is where a person states
 * the two representations and the record is written.
 *
 * WHAT MAKES IT SAFE TO BE PUBLIC. It cannot be reached without a handoff this
 * server signed inside the last hour (attestation-handoff.ts), and that
 * signature carries the ADDRESS — so a request cannot choose whose account it
 * writes against. It refuses unless BOTH representations are explicitly
 * affirmed in the body: there is no default, no pre-tick, and no path through
 * this file that records an attestation the caller did not make.
 *
 * WHAT IT GRANTS, AND HOW NARROWLY. The ordinary marketing-link grant and
 * nothing else — the same closed browse-and-buy allowlist
 * (EMAIL_GRANT_BROWSE_EXACT / _PREFIXES), the same cookie, the same seven days
 * that a click by an already-attested recipient mints. It is not a session, it
 * carries no user id, and it opens no account, order, partner or admin surface.
 * This is deliberately NOT a way past the login wall in general: attesting gets
 * somebody to the catalogue and the checkout, which is where the message they
 * clicked was sending them, and no further.
 *
 * AN ADDRESS WITH NO ACCOUNT IS NOT GRANTED ANYTHING. There is nowhere
 * authoritative to write a representation for someone who has no auth record,
 * and manufacturing an account to hold one would be inventing a customer to
 * carry a consent. They are sent to sign-up with the destination attached,
 * where the ordinary form collects both representations and writes them the
 * ordinary way. Their gift survives the trip: it rode in an httpOnly cookie
 * from the click, and an offer is bound to its address at redemption, so it
 * resolves once they are signed in.
 *
 * WHAT IT DOES NOT DEFEND AGAINST, stated rather than implied: someone who
 * FORWARDS the email inside the handoff's one-hour window can tick the boxes in
 * the recipient's name. That is the same exposure every emailed link in this
 * system already carries, bounded here by the shortest window of any of them —
 * an hour against the grant's seven days — and by the fact that the gift cannot
 * be SPENT by the forwardee: customer offers are resolved against the
 * purchasing address, not against the bearer of the link.
 */

/** Generous enough for a real person retrying, tight enough to be no oracle. */
const MAX_ATTEMPTS_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;

export async function POST(request: NextRequest) {
  const limit = await checkRateLimit(
    rateLimitKeyForRequest("attest", request),
    MAX_ATTEMPTS_PER_WINDOW,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { h?: unknown; ageConfirmed?: unknown; researchUseOnly?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  // BOTH, EXPLICITLY, BEFORE ANYTHING ELSE. Checked ahead of the signature so
  // that a half-completed form can never advance the flow even by one step.
  if (body.ageConfirmed !== true || body.researchUseOnly !== true) {
    return NextResponse.json(
      { ok: false, error: "Please confirm both statements to continue." },
      { status: 400 },
    );
  }

  const handoff = await verifyAttestationHandoff(
    typeof body.h === "string" ? body.h : null,
    { allows: emailGrantAllowsPath },
  );
  // One answer for expired, tampered, forged, wrong-version and
  // pointed-somewhere-it-may-not-go. The difference between them is only ever
  // useful to somebody probing.
  if (!handoff) {
    return NextResponse.json(
      { ok: false, error: "This link has expired. Open the most recent email we sent you, or sign in." },
      { status: 400 },
    );
  }

  const outcome = await recordAttestationForEmail(handoff.email);

  if (outcome === "failed") {
    return NextResponse.json(
      { ok: false, error: "We could not save that just now. Please try again in a moment." },
      { status: 503 },
    );
  }

  if (outcome === "no_account") {
    // No grant. Sign-up is where the representations are made and recorded for
    // somebody who has never had an account, and the destination rides along.
    return NextResponse.json({
      ok: true,
      needsAccount: true,
      destination: `/account/login?next=${encodeURIComponent(handoff.destination)}`,
    });
  }

  const response = NextResponse.json({ ok: true, destination: handoff.destination });

  const grant = await signEmailLinkGrant();
  if (!grant) {
    // The record is written either way — that is the part that matters and it
    // is not rolled back. Sign-in still reaches everything the grant would.
    return NextResponse.json({
      ok: true,
      destination: `/account/login?next=${encodeURIComponent(handoff.destination)}`,
    });
  }
  response.cookies.set({
    name: EMAIL_GRANT_COOKIE,
    value: grant,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: EMAIL_GRANT_MAX_AGE_SECONDS,
  });

  // RE-ARM THE GIFT. The click route set this cookie on the way in, so usually
  // it is already there — but a customer who took a detour, or whose browser
  // dropped it across the interstitial, must not lose the thing the email
  // promised. Same cookie, same attributes, same httpOnly bearer rules: it is
  // never put in a URL, because the checkout reads it server-side and the
  // browser has no reason to see it.
  if (handoff.offerToken && handoff.offerToken.length <= 128) {
    response.cookies.set({
      name: OFFER_COOKIE,
      value: handoff.offerToken,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: OFFER_COOKIE_MAX_AGE_SECONDS,
    });
  }

  return response;
}
