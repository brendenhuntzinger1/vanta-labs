import { NextResponse } from "next/server";

import { getSmsSignupConfig, getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { readPhoneOnFile, readSmsStanding } from "@/lib/sms-consent";
import { readExistingSpin } from "@/lib/spin/spin-service";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// MAY WE INVITE THIS PERSON TO SPIN?
//
// The wheel is the store's acquisition offer now — there is no welcome discount
// behind it any more — so something has to open over a product page and say so.
// This is the one question that card is allowed to ask, and it never works the
// answer out for itself. Every reason to stay silent is decided here.
//
// THE WHEEL'S OWN SWITCH IS THE ONLY KILL SWITCH. `spin_wheel.enabled` is what
// an operator reaches for, and turning it off makes /spin itself a 404 — so an
// invitation that survived it would be an interruption pointing at nothing. The
// SMS prompt switch beside it is NOT consulted: it gates a discount that no
// longer exists, and letting it silence the wheel would give one promotion two
// unrelated off switches, which is how a funnel dies without anyone noticing.
//
// ALREADY SPUN IS A HARD NO. One spin per address per campaign is enforced by
// the offer row's unique index whatever this says — a second press would only
// ever hand back the prize they already hold — but inviting somebody to do a
// thing they have already done is an advert for a dead end.
//
// THE NUMBER AND THE PERMISSION ARE TWO QUESTIONS WITH TWO ANSWERS.
//
// `needPhone` is whether the store has to ask for a number at all — it does
// not, if it already holds one. `askForTexts` is whether there is a text-list
// consent left to offer, which there is not for somebody already on the list
// or somebody who once said stop.
//
// Neither is ever a condition of the other. The wheel collects a number; the
// tick beside it is its own decision and buys nothing.
//
// NOTHING HERE MINTS, and there is no token in the reply. The page signs its
// own, for the session's own address — see app/spin/page.tsx. A credential in a
// JSON body is a credential in a log, and this one buys a $119.99 vial.
// ---------------------------------------------------------------------------

export async function GET() {
  // A session is not optional. This path is behind the customer wall and is
  // deliberately absent from the email-link grant's allowlist: a grant carries
  // no address, so there would be nobody to answer about.
  const user = await getAuthenticatedUser();
  const email = String(user?.email ?? "").trim().toLowerCase();

  // The shape is the same either way, so the card has no branch of its own to
  // get wrong. Silence is the default in every failure.
  const silent = {
    mayInvite: false,
    alreadySpun: false,
    askForTexts: false,
    needPhone: false,
    accountEmail: null as string | null,
    dismissCooldownDays: 7,
  };

  if (!email) return NextResponse.json(silent);

  try {
    const [wheel, sms] = await Promise.all([getSpinWheelConfig(), getSmsSignupConfig()]);
    if (!wheel.enabled) {
      return NextResponse.json({ ...silent, dismissCooldownDays: sms.dismissCooldownDays });
    }

    const [existing, standing, phoneOnFile] = await Promise.all([
      readExistingSpin({ email, campaignId: wheel.campaignId }),
      // A refused read answers "subscribed" (sms-consent.ts), which is the safe
      // direction here too: the cost of a wrong "subscribed" is one card
      // without a text box, and the cost of a wrong "none" is asking somebody
      // who already said stop.
      readSmsStanding(email),
      // A refused read answers "we have one", so a blip costs a number the
      // store could have collected rather than a field asked of somebody who
      // has already given it twice.
      readPhoneOnFile(email),
    ]);

    return NextResponse.json({
      mayInvite: !existing,
      alreadySpun: Boolean(existing),
      askForTexts: standing === "none",
      // Asked for only when there is nothing on file. The number already
      // stored is the one a later tick would subscribe.
      needPhone: !phoneOnFile,
      // Their own address, returned to their own authenticated session, so the
      // card can show which one the consent would be recorded against rather
      // than collecting one it is going to discard.
      accountEmail: email,
      dismissCooldownDays: sms.dismissCooldownDays,
    });
  } catch {
    // A control-store or database blip must not put a card on screen that the
    // wheel cannot honour.
    return NextResponse.json(silent);
  }
}
