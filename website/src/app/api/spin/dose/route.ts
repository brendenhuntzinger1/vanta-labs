import { NextResponse } from "next/server";

import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { chooseSpinDose } from "@/lib/spin/spin-dose";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// "I WON GLP-1 — I'LL TAKE THE 30mg."
//
// IDENTITY COMES FROM THE SESSION, exactly as the claim route does. There is no
// email in the body: the prize being changed is found by the verified address,
// so nobody can move somebody else's dose by typing their address.
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
    const verifiedEmail = String(user?.email ?? "").trim().toLowerCase();
    if (!verifiedEmail) {
      return NextResponse.json({ success: false, error: "Please sign in to choose your size." }, { status: 401 });
    }

    let label = "";
    try {
      const body = (await request.json()) as { label?: unknown };
      label = typeof body?.label === "string" ? body.label : "";
    } catch {
      label = "";
    }

    const config = await getSpinWheelConfig();
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
