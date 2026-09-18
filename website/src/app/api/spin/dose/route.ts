import { NextResponse } from "next/server";

import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { chooseSpinDose } from "@/lib/spin/spin-dose";
import { verifySpinToken } from "@/lib/spin/spin-token";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// "I WON GLP-1 — I'LL TAKE THE 30mg."
//
// IDENTITY COMES FROM THE SESSION, OR FROM THE SIGNED LINK. There is no email
// in the body: the prize being changed is found by an address this server
// established, so nobody can move somebody else's dose by typing their address.
//
// THE LINK IS HERE BECAUSE THE LIVE JOURNEY IS ANONYMOUS. The wheel was mailed
// to 104 people and is reachable on an email-link grant, which is deliberately
// a bare capability carrying no address (email/link-grant.ts). Four of the
// sixteen wedges are laddered and the picker renders from the PRIZE, so a
// quarter of anonymous winners were shown a size chooser whose every press
// answered 401 — and with the wall answering first, the words they got were
// "Sign in to continue", on a page reached from a link that had just proved
// who they were.
//
// Accepting the token is not a new trust. POST /api/spin already mints the
// prize on it, for the reason stated there: "The address in the token is
// trustworthy — this server signed it". Choosing a size moves nothing but that
// same address's own row, so this is strictly the smaller act.
//
// A SESSION THAT DISAGREES WITH THE LINK IS A FORWARDED LINK, and is refused
// rather than guessed at — the same 409 the mint path answers, for the same
// reason: neither identity authorises moving the other one's prize.
//
// THE BODY CARRIES ONE FIELD, and it is a label. Not a variant id, not a
// minimum, not a product, not a prize id. Everything else is derived server
// side from the offer row, so there is nothing here worth forging — see
// spin-dose.ts for what each refusal means.
//
// The wheel's kill switch is deliberately NOT consulted. Pausing stops new
// spins; it must not strand a prize somebody already won at whichever dose they
// had not yet chosen, which is the same reasoning the claim route carries.
// ---------------------------------------------------------------------------

/** What the customer is told, per refusal. Never the internal reason verbatim. */
const MESSAGES: Record<string, string> = {
  not_found: "We couldn't find a live prize on your account to update.",
  no_choice: "This prize comes in one size, so there's nothing to choose.",
  unknown_dose: "That size isn't one of the options for this prize.",
  dose_unavailable: "That size has just gone out of stock. Please choose another.",
  held_by_checkout: "Your prize is being used by an order right now. Finish or cancel that checkout, then try again.",
  write_failed: "We couldn't save that just now. Please try again.",
};

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser();
    const sessionEmail = String(user?.email ?? "").trim().toLowerCase();

    let label = "";
    let token = "";
    try {
      const body = (await request.json()) as { label?: unknown; token?: unknown };
      label = typeof body?.label === "string" ? body.label : "";
      token = typeof body?.token === "string" ? body.token.trim() : "";
    } catch {
      label = "";
    }

    const config = await getSpinWheelConfig();

    // A link for a PREVIOUS campaign is genuine and useless — the campaign is
    // inside the signature, so it cannot be forged, but honouring it would move
    // a prize in a promotion this holder was never mailed.
    const verified = token ? await verifySpinToken(token) : null;
    const linkEmail = verified && verified.campaignId === config.campaignId ? verified.email : "";

    if (sessionEmail && linkEmail && sessionEmail !== linkEmail) {
      return NextResponse.json(
        { success: false, error: "This link belongs to a different account. Sign out, or open the link sent to this address." },
        { status: 409 },
      );
    }

    // The session is the stronger claim and wins whenever there is one.
    const verifiedEmail = sessionEmail || linkEmail;
    if (!verifiedEmail) {
      return NextResponse.json({ success: false, error: "Please sign in to choose your size." }, { status: 401 });
    }

    const outcome = await chooseSpinDose({ verifiedEmail, campaignId: config.campaignId, label });

    if (!outcome.ok) {
      // 409 for the checkout hold: it is a state conflict the customer can
      // resolve, not a malformed request. Everything else is a bad choice.
      const status = outcome.reason === "held_by_checkout" ? 409 : 400;
      return NextResponse.json(
        { success: false, error: MESSAGES[outcome.reason] ?? MESSAGES.write_failed },
        { status },
      );
    }

    return NextResponse.json({
      success: true,
      dose: { label: outcome.label, minSubtotalCents: outcome.minSubtotalCents },
    });
  } catch (error) {
    // The internal detail goes to the log, never to the browser.
    console.error("[spin] dose choice failed", error);
    return NextResponse.json({ success: false, error: MESSAGES.write_failed }, { status: 500 });
  }
}
