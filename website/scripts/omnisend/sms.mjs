import { link } from "./lib.mjs";

/**
 * The SMS catalogue (spec §3.6). Each entry is the text exactly as the
 * recipient reads it: it opens "Vanta Labs:", puts the link straight after
 * the message, then "Research use only." and closes "Reply STOP to opt out."
 * A text cannot be conditional, so no entry carries a code, and no text
 * claims an email was sent: an SMS-only consent may never receive one. The
 * two welcome-offer texts are the exception and the reason is structural:
 * they are sent only inside the welcome-offer automation's segment splits,
 * where the store has already minted the code (and, in one branch, the
 * vial), so the properties they name are never blank.
 *
 * Omnisend appends its own STOP keyword when an automation or campaign has
 * `compliance.isStopKeywordIncluded` on. automations.mjs therefore strips the
 * closing sentence from `text` and hands it to Omnisend as `stopKeywordText`,
 * so the recipient sees it once and the catalogue still reads as sent.
 *
 * Length: Omnisend shortens links on the wire, so each text is measured with
 * the link replaced by a shortened one and kept under 160 characters (one
 * GSM-7 segment). PRODUCT NAME in the restock text is a placeholder the owner
 * replaces in the campaign.
 */

export const STOP_SENTENCE = "Reply STOP to opt out.";
export const RESEARCH_SENTENCE = "Research use only.";

const sms = (path, campaign) => link(path, { campaign, medium: "sms" });
const text = (body, path, campaign) => `Vanta Labs: ${body} ${sms(path, campaign)} ${RESEARCH_SENTENCE} ${STOP_SENTENCE}`;

export const SMS = {
  welcome: {
    text: text("thanks for subscribing. Batch reports for every product are in the COA library.", "/coa-library", "welcome"),
    whenUsed: "Welcome automation, straight after the first email, for contacts subscribed to SMS. It stands alone: an SMS-only consent may never get the email, so it promises nothing about one, and the code stays in the email because a text cannot be hidden when the property is empty.",
  },
  // The welcome-offer automation's texts. Each sits in a split-guaranteed
  // branch (vl-welcome-gift-ready, inside vl-welcome-ready), so unlike every
  // other text they may name the code: the property is filled wherever they
  // are sent. The vial is claimed through the email's button (the claim link
  // is a bearer token the text does not carry); the code works anywhere.
  "welcome-offer-gift": {
    text: text("welcome offer: free GHK-Cu vial or 15% off a first order. Code [[contact.custom_properties.vl_welcome_code]].", "/products", "welcome-offer"),
    whenUsed: "Welcome-offer automation, 20 minutes after the offer email, in the branch where the vial was minted (segment vl-welcome-gift-ready). The property is never empty there.",
  },
  "welcome-offer-code": {
    text: text("welcome code [[contact.custom_properties.vl_welcome_code]]: 15% off a first order. One use, this address.", "/products", "welcome-offer"),
    whenUsed: "Welcome-offer automation, 20 minutes after the code-only email, in the branch where no vial could be minted (segment vl-welcome-ready without vl-welcome-gift-ready).",
  },
  cart: {
    text: text("your cart is still saved. Batch reports are on each product page.", "/cart", "abandoned-cart"),
    whenUsed: "Abandoned-cart automation, 27 hours after the trigger (after the second email).",
  },
  checkout: {
    text: text("your checkout is saved and nothing has been charged.", "/checkout", "abandoned-checkout"),
    whenUsed: "Abandoned-checkout automation, 27 hours after the trigger (after the second email).",
  },
  winback: {
    text: text("it has been a while. The current batch report for every product is on its page.", "/products", "win-back"),
    whenUsed: "Win-back automation, one day after the first email. The code is only in the second email, so the text names none.",
  },
  // THE WHEEL. Owner-sent, either channel, and deliberately vague about the
  // prize because the draw has not happened when the text is written: naming
  // any reward would be a promise the wheel might not keep. "a reward to claim
  // with your next order" is the whole truth — every spin wins, and nothing is
  // unconditional.
  //
  // It names no count. Sixteen WEDGES grant fifteen REWARDS (one sits on two
  // wedges), so "16 prizes" would be false; the page states both numbers and a
  // text has no room to.
  spin: {
    text: text("your spin is ready. Every spin wins a reward for your next order.", "/spin", "spin-wheel"),
    whenUsed: "Owner-sent spin-wheel campaign, email or SMS or both. The link opens the wheel; it does not spin it, so a link preview cannot spend the recipient's one spin. One spin per contact per campaign, so a reminder text reaches the same saved result rather than a second draw.",
  },
  restock: {
    text: text("PRODUCT NAME is back in the catalogue with a new batch report filed.", "/products", "campaign-restock"),
    whenUsed: "Owner-sent restock campaign. Replace PRODUCT NAME with the listing's name; state stock only as the live store shows it.",
  },
  promotion: {
    text: text("a subscriber offer is on. The code and terms are in your email.", "/products", "campaign-promotion"),
    whenUsed: "Owner-sent campaign text beside the VL promotion email. The code lives in the email so the text needs no per-contact property.",
  },
  "promotion-final-day": {
    text: text("the subscriber offer ends today at 11:59 PM ET. Terms are in your email.", "/products", "campaign-final-day"),
    whenUsed: "Owner-sent on the actual last day of an offer, beside the VL promotion-final-day email. One honest deadline; no timers.",
  },
};

/** The message body Omnisend sends when it appends the STOP keyword itself. */
export function smsBody(key) {
  const entry = SMS[key];
  if (!entry) throw new Error(`unknown SMS ${key}`);
  return entry.text.slice(0, -STOP_SENTENCE.length).trimEnd();
}

export const SMS_KEYS = Object.keys(SMS);
