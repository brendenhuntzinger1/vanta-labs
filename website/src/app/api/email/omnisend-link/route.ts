import { NextRequest, NextResponse } from "next/server";
import { resolveSitePath } from "@/lib/email/cta-path";
import { withUtm } from "@/lib/email/utm";
import { emailLinkLanding, setEmailLinkGrantCookie } from "@/lib/email/recipient-attestation";
import { verifyOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import { siteUrl } from "@/lib/site-identity";

export const dynamic = "force-dynamic";

/**
 * Omnisend click route: the account wall's door for Omnisend email and SMS.
 *
 * Omnisend sends the mail, so it cannot mint the per-recipient browse grant
 * the in-house click routes mint. Instead every contact carries a signed
 * token in the custom property `vl_link` (link-token.ts) with the address
 * sealed inside it, every template link hands it back here, and this route
 * does what /api/email/click does on the far side of its own signature check:
 * open the token, check attestation, mint the grant, stamp attribution,
 * redirect. The address is never in the URL.
 *
 * THE REDIRECT TARGET NEVER COMES FROM THE REQUEST UNVALIDATED. The in-house
 * routes read their destination from a database row; Omnisend has no row for
 * this route to read, so the destination arrives in `to`. It is therefore
 * passed straight into resolveSitePath and nowhere else: anything that does
 * not resolve to this site's origin becomes the catalogue, and that is the
 * difference between a tracking link and an open redirect on a domain
 * customers trust because it arrived in our email.
 *
 * The `utm_*` values are labels, not instructions. They tag the destination,
 * which is how an order is later attributed (order_attribution reads the
 * landing page's parameters); they cannot influence where anyone is sent.
 * No cookie is set here beyond the browse grant: a campaign cookie set on a
 * click regardless of the cookie banner would contradict the Cookie Policy,
 * and nothing read one.
 *
 * A failure must never strand a customer on an error page: every path below
 * still redirects. An unverifiable link lands on sign-in with the validated
 * destination as `next=`, which is exactly where every email link landed
 * before any of this existed.
 */

const UTM_SOURCE = "omnisend";

/**
 * Anyone can put anything in a utm_ parameter. Junk should cost a truncated
 * label in a report, not a Set-Cookie header no proxy will forward.
 */
const MAX_LABEL_LENGTH = 100;

function label(value: string | null): string {
  return String(value ?? "").trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * The site's own origin, which every redirect is built against. siteUrl()
 * never throws and falls back to the canonical www host; the request's origin
 * is the last resort only because it always parses, and a redirect to the
 * origin a request arrived on is not a redirect anywhere new.
 */
function siteOrigin(request: NextRequest): string {
  try {
    return new URL(siteUrl()).origin;
  } catch {
    return request.nextUrl.origin;
  }
}

function sitePathOf(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);
  return `${url.pathname}${url.search}`;
}

export async function GET(request: NextRequest) {
  const origin = siteOrigin(request);
  const login = new URL("/account/login", origin);

  try {
    const params = request.nextUrl.searchParams;
    const token = params.get("t");
    const campaign = label(params.get("utm_campaign"));
    // Two media exist; anything else is a typo in a template, filed as email
    // rather than splitting a report on a misspelling.
    const medium = params.get("utm_medium") === "sms" ? "sms" : "email";
    const content = label(params.get("utm_content"));

    // THE ONLY READ OF `to`, and it goes into the validator and nowhere else.
    // Tagged on the way out, on the destination that was actually chosen, so
    // GA4 files the arrival under Omnisend rather than `direct`.
    const destination = withUtm(
      resolveSitePath(params.get("to"), origin, "/products"),
      { source: UTM_SOURCE, medium, campaign, content },
      origin,
    );
    login.searchParams.set("next", sitePathOf(destination));

    // THE ADDRESS COMES FROM INSIDE THE TOKEN AND NOWHERE ELSE. v2 seals it
    // (link-token.ts), so the URL never carries it and nothing on the request
    // can name a different one: a token replayed by somebody else still opens
    // to the contact it was minted for, and only their attestation is checked.
    const verified = await verifyOmnisendLink(token);
    if (!verified) {
      // Record nothing: an unverifiable click is not evidence of a campaign.
      return NextResponse.redirect(login, { status: 302 });
    }
    const email = verified.email;

    // WHERE THIS CLICK CAN ACTUALLY GO. An attested recipient gets the
    // destination and the grant; one who has never made the 21+ and
    // research-use representations is sent to the step that collects them,
    // carrying this destination. See recipient-attestation.ts.
    const landing = await emailLinkLanding({ email, destination });
    const response = NextResponse.redirect(landing.destination, { status: 302 });

    // THE CAPABILITY TO ACTUALLY REACH THE DESTINATION. Null when the
    // recipient is on their way to the interstitial instead: the grant is
    // minted there, after the two statements are made, and never before.
    if (landing.grant) setEmailLinkGrantCookie(response, landing.grant);

    return response;
  } catch {
    // Whatever broke, the customer clicked a link and must reach a page. The
    // sign-in page with the destination preserved is the pre-existing outcome.
    return NextResponse.redirect(login, { status: 302 });
  }
}
