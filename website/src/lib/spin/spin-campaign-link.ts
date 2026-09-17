import "server-only";

import { getSpinWheelConfig } from "@/lib/admin-control";
import { signSpinToken } from "@/lib/spin/spin-token";

// ---------------------------------------------------------------------------
// HOW A CAMPAIGN SENDS A WHEEL.
//
// An operator writes an ordinary campaign in Admin → Email and sets the CTA
// path to `/spin`. Nothing else about composing or sending changes: no new
// campaign column, no new template, no second sender.
//
// THE PERSONALISED LINK IS MINTED AT CLICK TIME, NOT AT SEND TIME, and that is
// the whole reason this is a function rather than a template variable:
//
//   * The email body never contains a per-recipient credential, so a forwarded
//     or screenshotted email carries nothing on its own.
//   * /api/email/click has already VERIFIED the address — the recipient
//     signature is checked before this is reached — so the identity this signs
//     over is one the server established, not one the URL asserted.
//   * A campaign sent before the wheel was switched on, or under a previous
//     spin campaign id, resolves against the CURRENT config when it is
//     actually clicked rather than against whatever was true at send.
//
// THE TWO CAMPAIGN IDS ARE NOT THE SAME THING, and conflating them would be a
// real bug. The EMAIL campaign id identifies the send (open and click
// reporting). The SPIN campaign id scopes one-spin-per-customer and lives in
// the control store. Two different emails in the same spin campaign must share
// one spin, and the same person must be able to spin again next quarter — both
// of which only work if the spin token carries the spin campaign.
// ---------------------------------------------------------------------------

/** The CTA path an operator types to make a campaign send the wheel. */
export const SPIN_CTA_PATH = "/spin";

/**
 * Turn a `/spin` destination into that recipient's own spin link.
 *
 * Returns the destination unchanged for every other path, and unchanged when
 * the wheel is off or the link cannot be signed — a campaign whose CTA cannot
 * be personalised should still land the customer on the page, where they will
 * be told the link is not valid, rather than fail the click entirely.
 *
 * `verifiedEmail` MUST be an address the caller has already verified. The click
 * route checks verifyCampaignRecipient before calling this.
 */
export async function attachSpinLink(destination: string, verifiedEmail: string): Promise<string> {
  const email = String(verifiedEmail ?? "").trim().toLowerCase();
  if (!email) return destination;

  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return destination;
  }

  // Exact path only. A campaign pointing at /spin-something-else is not this.
  if (url.pathname !== SPIN_CTA_PATH) return destination;

  try {
    const config = await getSpinWheelConfig();
    if (!config.enabled) return destination;

    const token = await signSpinToken(email, config.campaignId);
    if (!token) return destination;

    url.searchParams.set("t", token);
    return url.toString();
  } catch {
    // A control-store blip must not cost the click.
    return destination;
  }
}
