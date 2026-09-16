import { readFileSync } from "node:fs";
import { SMS, STOP_SENTENCE, smsBody } from "./sms.mjs";
import { SUBJECTS } from "./templates.mjs";

/**
 * Automations (spec §6). Every flow is created DISABLED (post_automations
 * creates them that way; nothing here calls enable). The owner enables each
 * one from the Omnisend dashboard after reviewing the test sends.
 *
 * Template ids come from assets/created.json and segment ids from
 * assets/segments.json, both written as each asset was created, so a flow can
 * only be rendered once the emails and segments it references exist.
 *
 * Every send block is subject to sendingThresholds subscribed/subscribed
 * (spec §3.2): an SMS block is skipped for a contact without SMS consent and
 * the flow continues, which is why an SMS can sit in the main sequence.
 *
 * Recipient-timezone sending: post_automations exposes no timezone option on
 * delays or send blocks (only allowedWeekdays and a specificTime mode), so
 * none is set. Quiet hours for SMS are an account setting the owner turns on.
 */

function readJson(name) {
  try {
    return JSON.parse(readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

const created = () => ({ templates: readJson("created.json"), segments: readJson("segments.json") });

const SENDER = "Vanta Labs";
const LANG = "en_US";

let counter = 0;
const tid = (label) => `${label}-${(counter += 1)}`;

/** A send-email block: template id from created.json, subject and preview from SUBJECTS. */
export function email(templateKey) {
  const templateID = created().templates[templateKey];
  if (!templateID) throw new Error(`template ${templateKey} has not been created yet`);
  const copy = SUBJECTS[templateKey];
  if (!copy) throw new Error(`no SUBJECTS entry for ${templateKey}`);
  return { temporaryID: tid(templateKey), type: "action", action: { type: "sendEmail", sendEmail: { templateID, subject: copy.subject, preheader: copy.preview, senderName: SENDER, language: LANG } } };
}

/**
 * A send-SMS block from the catalogue. The catalogue text ends with the STOP
 * sentence; Omnisend appends its own opt-out keyword, so the body is the text
 * without that sentence and the sentence is handed over as stopKeywordText.
 * The unsubscribe link is off: STOP is present, the form only takes US and CA
 * numbers, and the link would eat the 160-character budget the texts are cut to.
 */
export function sms(key) {
  if (!SMS[key]) throw new Error(`unknown SMS ${key}`);
  return {
    temporaryID: tid(`sms-${key}`),
    type: "action",
    action: {
      type: "sendSms",
      sendSms: {
        message: smsBody(key),
        compliance: { isStopKeywordIncluded: true, stopKeywordText: STOP_SENTENCE, isUnsubscribeLinkIncluded: false },
        isLinkShorteningEnabled: true,
      },
    },
  };
}

export function wait(label, amount, units) {
  return { temporaryID: tid(label), type: "delay", delay: { mode: "duration", duration: { amount, units } } };
}

export function tag(label, value, remove = false) {
  return { temporaryID: tid(label), type: "action", action: remove ? { type: "removeTag", removeTag: { value } } : { type: "addTag", addTag: { value } } };
}

/** Split on membership of a segment (contact filter, field segmentID). */
export function splitOnSegment(label, segmentKey, trueBlocks, falseBlocks) {
  const segmentID = created().segments[segmentKey];
  if (!segmentID) throw new Error(`segment ${segmentKey} has not been created yet`);
  return { temporaryID: tid(label), type: "split", split: { filterGroup: { logicalOperator: "and", filters: [{ type: "contact", field: "segmentID", operator: "eq", value: segmentID }] }, trueBlocks, falseBlocks } };
}

/** Trigger on entering a segment (origin omnisend), the way the sunset and win-back flows start. */
function enteredSegment(segmentKey) {
  const segmentID = created().segments[segmentKey];
  if (!segmentID) throw new Error(`segment ${segmentKey} has not been created yet`);
  return { condition: { event: "entered segment", origin: "omnisend", filterGroups: [{ logicalOperator: "and", filters: [{ field: "segment_id", operator: "eq", value: segmentID }] }] } };
}

/** Split on whether a message block above was clicked. */
export function splitOnClick(label, blockTemporaryID, trueBlocks, falseBlocks) {
  return { temporaryID: tid(label), type: "split", split: { filterGroup: { logicalOperator: "and", filters: [{ type: "message", field: "blockID", operator: "clickedEmail", value: blockTemporaryID, urlMatch: { operator: "any" } }] }, trueBlocks, falseBlocks } };
}

const thresholds = { email: "subscribed", sms: "subscribed" };
const once = { mode: "once" };
const every = (amount, units) => ({ mode: "interval", duration: { amount, units } });
const api = (event) => ({ event, origin: "api" });

/**
 * The final-reminder split an abandonment flow ends on. The store sets the
 * readiness flags only when a gift or code exists (segments.mjs), so each of
 * the four variants is only ever sent to a contact whose card is filled.
 */
function finalReminder(kind) {
  return splitOnSegment(`${kind}-gift`, "vl-recovery-gift-ready",
    [splitOnSegment(`${kind}-gift-code`, "vl-recovery-code-ready", [email(`${kind}-3-gift-code`)], [email(`${kind}-3-gift`)])],
    [splitOnSegment(`${kind}-code`, "vl-recovery-code-ready", [email(`${kind}-3-code`)], [email(`${kind}-3-plain`)])]);
}

export const AUTOMATIONS = {
  welcome: () => {
    counter = 0;
    return {
      name: "VL · Welcome",
      trigger: { condition: { event: "subscribed to marketing" } },
      blocks: [
        // Informational: the welcome code may not exist yet (form sign-ups get
        // theirs on the next nightly reconcile) and a checkout opt-in never gets one.
        email("welcome-1"),
        // Skipped by the SMS threshold for anyone without SMS consent.
        sms("welcome"),
        wait("w1", 2, "d"),
        // vl_welcome_ready is "yes" only once the store has minted the code, so
        // the card is sent only where it can never be blank.
        splitOnSegment("code-2", "vl-welcome-ready", [email("welcome-2-code")], [email("welcome-2")]),
        wait("w2", 3, "d"),
        splitOnSegment("code-3", "vl-welcome-ready", [email("welcome-3")], [email("welcome-3-nocode")]),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: once },
    };
  },

  "abandoned-cart": () => {
    counter = 0;
    return {
      name: "VL · Abandoned cart",
      trigger: { condition: api("added product to cart"), inactivitySettings: { duration: { amount: 1, units: "h" } } },
      blocks: [
        email("cart-1"),
        wait("w1", 23, "h"),
        email("cart-2"),
        wait("w2", 3, "h"),
        sms("cart"),
        wait("w3", 45, "h"),
        finalReminder("cart"),
      ],
      exitConditions: [api("placed order"), api("started checkout")],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(7, "d") },
    };
  },

  "abandoned-checkout": () => {
    counter = 0;
    return {
      name: "VL · Abandoned checkout",
      trigger: { condition: api("started checkout"), inactivitySettings: { duration: { amount: 1, units: "h" } } },
      blocks: [
        email("checkout-1"),
        wait("w1", 23, "h"),
        email("checkout-2"),
        wait("w2", 3, "h"),
        sms("checkout"),
        wait("w3", 45, "h"),
        finalReminder("checkout"),
      ],
      exitConditions: [api("placed order")],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(7, "d") },
    };
  },

  "browse-abandonment": () => {
    counter = 0;
    return {
      name: "VL · Browse abandonment",
      trigger: { condition: api("viewed product"), inactivitySettings: { duration: { amount: 4, units: "h" } } },
      blocks: [email("browse-1")],
      exitConditions: [api("added product to cart"), api("started checkout"), api("placed order")],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(7, "d") },
    };
  },

  "post-purchase": () => {
    counter = 0;
    return {
      name: "VL · Post-purchase",
      trigger: { condition: api("paid for order") },
      blocks: [
        wait("w1", 1, "d"),
        email("post-purchase-1"),
        wait("w2", 9, "d"),
        email("post-purchase-2"),
        wait("w3", 3, "d"),
        // A second order earns the repeat thank-you; the milestone note is for
        // VIPs only, a week later so the two thank-yous never land together.
        splitOnSegment("repeat", "vl-repeat-customers", [
          email("repeat-customer"),
          wait("w4", 7, "d"),
          splitOnSegment("vip", "vl-vip", [email("vip-milestone")], []),
        ], []),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(30, "d") },
    };
  },

  replenishment: () => {
    counter = 0;
    return {
      name: "VL · Replenishment",
      trigger: { condition: api("paid for order") },
      blocks: [
        wait("w1", 45, "d"),
        splitOnSegment("bought-again", "vl-bought-30d", [], [email("replenishment")]),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(60, "d") },
    };
  },

  /**
   * Win-back enters on the lapsed-60 segment, not on the order itself.
   * Entering on "paid for order" with a 60-day wait and a 180-day limiter
   * meant a buyer who ordered again (and so exited) could not re-enter for
   * 180 days from the FIRST order, however lapsed they later became. The
   * segment already encodes the 60 days since the last order, so the flow
   * starts with the email, and the limiter only has to outlast one run
   * (1 d + 30 d, plus a day) for a buyer who lapses again to be won back again.
   */
  "win-back": () => {
    counter = 0;
    return {
      name: "VL · Win-back",
      trigger: enteredSegment("vl-lapsed-60"),
      blocks: [
        email("winback-1"),
        wait("w1", 1, "d"),
        sms("winback"),
        wait("w2", 30, "d"),
        splitOnSegment("code-ready", "vl-winback-ready", [email("winback-2")], [email("winback-2-nocode")]),
      ],
      exitConditions: [api("paid for order")],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(32, "d") },
    };
  },

  sunset: () => {
    counter = 0;
    const ask = email("sunset");
    return {
      name: "VL · Sunset",
      trigger: enteredSegment("vl-unengaged-120"),
      blocks: [
        ask,
        wait("w1", 7, "d"),
        splitOnClick("clicked", ask.temporaryID, [tag("engaged", "engaged"), tag("unsunset", "sunset", true)], [tag("sunset", "sunset")]),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: every(180, "d") },
    };
  },
};

export const AUTOMATION_KEYS = Object.keys(AUTOMATIONS);
