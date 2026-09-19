import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { recordSmsConsent } from "@/lib/sms-consent";
import { acceptableSmsPhone } from "@/lib/sms-consent-text";

export const dynamic = "force-dynamic";

/**
 * THE STANDALONE SMS OPT-IN, FOR SOMEBODY WITH NO ACCOUNT.
 *
 * /api/offers/welcome already records consent and is already public, and this
 * endpoint exists anyway. Three reasons, none of them cosmetic:
 *
 *   1. IT MINTS NOTHING. That route's whole purpose is the welcome discount —
 *      it calls claimWelcomeOffer and returns a code. The public opt-in page
 *      does not advertise a discount and must not quietly start one ticking
 *      behind a visitor who was only asked about text messages.
 *   2. ITS REFUSAL MESSAGES ARE WRITTEN FOR A SHOPPER WHO IS SIGNED IN. With
 *      no session and no typed address it answers "Please sign in again to
 *      claim this offer", which is nonsense on a page that never mentioned an
 *      account or an offer.
 *   3. THE CONSENT IS THE WHOLE TRANSACTION HERE, so the tick is a required
 *      field of the request rather than something the UI is trusted to have
 *      enforced. See below.
 *
 * WHAT IT DOES NOT DUPLICATE: the writing. It calls recordSmsConsent, the same
 * function the checkout, the sign-up and the account page call, so there is
 * still exactly one place that decides what a consent row looks like, one
 * disclosure version stamped on it, and one upsert keyed on the number. A
 * person who consents here and later at the checkout has ONE row, not two.
 *
 * THE TICK IS NOT INFERRED FROM THE NUMBER. A phone number in the body is a
 * phone number; it is not permission to text marketing to it. `consent` must
 * arrive explicitly true or nothing is written at all — no row, no contact, no
 * "we'll just mark them pending". A client that forgets to send it gets a
 * refusal rather than a subscriber, which is the direction this has to fail
 * in.
 *
 * NOTHING IS STORED ON A REFUSAL. There is no account here to hang a
 * phone-on-file against, so an untick writes nothing rather than parking a
 * number somewhere it would later be mistaken for a lead.
 *
 * IT NEVER CLAIMS THE NUMBER IS VERIFIED. recordSmsConsent leaves `status` at
 * the table's default of 'pending'; this store sends no confirmation code, and
 * a syntactically valid number is not a number somebody has proved they own.
 * The column a carrier would ask about says what is true.
 */

/** Ten an hour per requester: a mistyped number a few times, never a script. */
const HOURLY_LIMIT = 10;

export async function POST(request: Request) {
  const limit = await checkRateLimit(rateLimitKeyForRequest("sms-subscribe", request), HOURLY_LIMIT, 60 * 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Please wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { phone?: unknown; email?: unknown; consent?: unknown };
  try {
    body = (await request.json()) as { phone?: unknown; email?: unknown; consent?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Enter your mobile number." }, { status: 400 });
  }

  // STRICTLY TRUE. Not truthy: "false", 0 and "" are all things a form
  // serialiser can produce for a box nobody ticked, and every one of them
  // would sail through a loose check as permission to send marketing.
  if (body.consent !== true) {
    return NextResponse.json(
      { ok: false, error: "Tick the box to agree to receive marketing text messages." },
      { status: 400 },
    );
  }

  const phone = acceptableSmsPhone(String(body.phone ?? ""));
  if (!phone) {
    return NextResponse.json({ ok: false, error: "That does not look like a mobile number." }, { status: 400 });
  }

  // THE ADDRESS IS REQUIRED, AND NOT AS A FORMALITY. The number reaches
  // Omnisend — the service that actually sends the messages — only as part of
  // a contact, and an Omnisend contact is identified by email address
  // (sms-consent.ts pushToOmnisend, marketing/omnisend/contacts.ts). A row
  // with no address is a consent this store has recorded and can never act on,
  // which is a worse outcome for the subscriber than being asked for one.
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 320) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }

  // recordSmsConsent never throws: a refused write is logged and answered
  // false. It also handles the case that matters most here — a number that
  // once replied STOP and is now ticking the box again clears the stop and
  // counts the resubscribe rather than quietly overwriting the history.
  const recorded = await recordSmsConsent({ email, phone, source: "sms-page", userId: null });
  if (!recorded) {
    return NextResponse.json(
      { ok: false, error: "This did not go through. Please try again." },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, subscribed: true });
}
