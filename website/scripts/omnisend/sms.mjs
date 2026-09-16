import { link } from "./lib.mjs";

/**
 * The SMS catalogue (spec §3.6). Each entry is the text exactly as the
 * recipient reads it: it opens "Vanta Labs:", puts the link straight after
 * the message, then "Research use only." and closes "Reply STOP to opt out."
 * A text cannot be conditional, so no entry carries a code, and no text
 * claims an email was sent: an SMS-only consent may never receive one.
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
