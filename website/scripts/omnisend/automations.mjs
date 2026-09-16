import { readFileSync } from "node:fs";
import { link } from "./lib.mjs";

/**
 * Automations (spec §6). Every flow is created DISABLED; the owner enables
 * each one from the Omnisend dashboard after reviewing the test sends.
 *
 * Template and segment ids come from assets/created.json, written by the build
 * as assets are created, so a flow can only be rendered once its emails exist.
 */

function readJson(name) {
  try {
    return JSON.parse(readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

/** Template ids from created.json; segment ids from segments.json (written as each was created). */
function created() {
  const all = readJson("created.json");
  return { templates: all.templates ?? {}, segments: { ...(all.segments ?? {}), ...readJson("segments.json") } };
}

const SENDER = "Vanta Labs";
const LANG = "en_US";

let counter = 0;
const tid = (label) => `${label}-${(counter += 1)}`;

export function email(label, templateKey, subject, preheader) {
  const ids = created();
  const templateID = ids.templates?.[templateKey];
  if (!templateID) throw new Error(`template ${templateKey} has not been created yet`);
  return { temporaryID: tid(label), type: "action", action: { type: "sendEmail", sendEmail: { templateID, subject, preheader, senderName: SENDER, language: LANG } } };
}

/** Texts keep Omnisend's STOP / unsubscribe compliance text switched on. */
export function sms(label, message) {
  return { temporaryID: tid(label), type: "action", action: { type: "sendSms", sendSms: { message, compliance: { isStopKeywordIncluded: true, isUnsubscribeLinkIncluded: true }, isLinkShorteningEnabled: true } } };
}

export function wait(label, amount, units) {
  return { temporaryID: tid(label), type: "delay", delay: { mode: "duration", duration: { amount, units } } };
}

export function tag(label, value, remove = false) {
  return { temporaryID: tid(label), type: "action", action: remove ? { type: "removeTag", removeTag: { value } } : { type: "addTag", addTag: { value } } };
}

/** Split on membership of a segment (contact filter, field segmentID). */
export function splitOnSegment(label, segmentKey, trueBlocks, falseBlocks) {
  const ids = created();
  const segmentID = ids.segments?.[segmentKey];
  if (!segmentID) throw new Error(`segment ${segmentKey} has not been created yet`);
  return { temporaryID: tid(label), type: "split", split: { filterGroup: { logicalOperator: "and", filters: [{ type: "contact", field: "segmentID", operator: "eq", value: segmentID }] }, trueBlocks, falseBlocks } };
}

/** Split on whether a message block above was clicked. */
export function splitOnClick(label, blockTemporaryID, trueBlocks, falseBlocks) {
  return { temporaryID: tid(label), type: "split", split: { filterGroup: { logicalOperator: "and", filters: [{ type: "message", field: "blockID", operator: "clickedEmail", value: blockTemporaryID, urlMatch: { operator: "any" } }] }, trueBlocks, falseBlocks } };
}

const thresholds = { email: "subscribed", sms: "subscribed" };
const smsLink = (path, campaign) => link(path, { campaign, medium: "sms" });

export const AUTOMATIONS = {
  welcome: () => {
    counter = 0;
    return {
      name: "VL · Welcome",
      trigger: { condition: { event: "subscribed to marketing" } },
      blocks: [
        email("welcome-1", "welcome-1", "Welcome to Vanta Labs", "What we sell, and how we document it."),
        sms("welcome-sms", `Vanta Labs: thanks for subscribing. Code [[contact.custom_properties.vl_welcome_code]] takes 10% off a first order until [[contact.custom_properties.vl_welcome_ends]]. Research use only. ${smsLink("/products", "welcome")}`),
        wait("w1", 2, "d"),
        email("welcome-2", "welcome-2", "Every batch has a published report", "Search a lot number and read the actual document."),
        wait("w2", 3, "d"),
        email("welcome-3", "welcome-3", "How ordering works", "Dispatch by 2PM ET, tracking after dispatch."),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "once" } },
    };
  },

  "abandoned-cart": () => {
    counter = 0;
    return {
      name: "VL · Abandoned cart",
      trigger: { condition: { event: "added product to cart", origin: "api" }, inactivitySettings: { duration: { amount: 1, units: "h" } } },
      blocks: [
        email("cart-1", "cart-1", "Your cart is saved", "Everything is still in it."),
        wait("w1", 23, "h"),
        email("cart-2", "cart-2", "Every batch has a published report", "Search a lot number and read the actual document."),
        wait("w2", 3, "h"),
        sms("cart-sms", `Vanta Labs: your cart is still saved. Batch reports are on each product page. ${smsLink("/cart", "abandoned-cart")}`),
        wait("w3", 45, "h"),
        splitOnSegment("recent-buyer", "vl-bought-30d",
          [email("cart-3-nocode", "cart-3-nocode", "One more note about your cart", "Your cart is still saved.")],
          [email("cart-3", "cart-3", "A code for your saved cart", "10% off, valid until the date inside.")]),
      ],
      exitConditions: [{ event: "placed order", origin: "api" }, { event: "started checkout", origin: "api" }],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 7, units: "d" } } },
    };
  },

  "abandoned-checkout": () => {
    counter = 0;
    return {
      name: "VL · Abandoned checkout",
      trigger: { condition: { event: "started checkout", origin: "api" }, inactivitySettings: { duration: { amount: 1, units: "h" } } },
      blocks: [
        email("checkout-1", "checkout-1", "Finish when you are ready", "Your checkout is saved. Nothing has been charged."),
        wait("w1", 3, "h"),
        sms("checkout-sms", `Vanta Labs: your checkout is saved and nothing has been charged. Finish here: ${smsLink("/checkout", "abandoned-checkout")}`),
        wait("w2", 20, "h"),
        email("checkout-2", "checkout-2", "Still here when you are", "Dispatch by 2PM ET, tracking after dispatch."),
        wait("w3", 48, "h"),
        splitOnSegment("recent-buyer", "vl-bought-30d",
          [email("checkout-3-nocode", "checkout-3-nocode", "One more note about your checkout", "Your checkout is still saved.")],
          [email("checkout-3", "checkout-3", "A code for your saved checkout", "10% off, valid until the date inside.")]),
      ],
      exitConditions: [{ event: "placed order", origin: "api" }],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 7, units: "d" } } },
    };
  },

  "browse-abandonment": () => {
    counter = 0;
    return {
      name: "VL · Browse abandonment",
      trigger: { condition: { event: "viewed product", origin: "api" }, inactivitySettings: { duration: { amount: 4, units: "h" } } },
      blocks: [email("browse-1", "browse-1", "You were looking at this", "The batch report is on the product page.")],
      exitConditions: [{ event: "added product to cart", origin: "api" }, { event: "placed order", origin: "api" }],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 7, units: "d" } } },
    };
  },

  "post-purchase": () => {
    counter = 0;
    return {
      name: "VL · Post-purchase",
      trigger: { condition: { event: "paid for order", origin: "api" } },
      blocks: [
        wait("w1", 1, "d"),
        email("post-purchase-1", "post-purchase-1", "Your batch report", "Find the certificate for what you bought."),
        wait("w2", 9, "d"),
        email("post-purchase-2", "post-purchase-2", "Also in the catalogue", "Selected from what is ordered alongside yours."),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 30, units: "d" } } },
    };
  },

  replenishment: () => {
    counter = 0;
    return {
      name: "VL · Replenishment",
      trigger: { condition: { event: "paid for order", origin: "api" } },
      blocks: [
        wait("w1", 45, "d"),
        splitOnSegment("recent-buyer", "vl-bought-30d", [], [email("replenishment", "replenishment", "When you need to reorder", "Your previous items, and their current batches.")]),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 60, units: "d" } } },
    };
  },

  "win-back": () => {
    counter = 0;
    return {
      name: "VL · Win-back",
      trigger: { condition: { event: "paid for order", origin: "api" } },
      blocks: [
        wait("w1", 60, "d"),
        splitOnSegment("recent-buyer", "vl-bought-30d", [], [
          email("winback-1", "winback-1", "It has been a while", "A code, and the current batch reports."),
          wait("w2", 1, "d"),
          sms("winback-sms", `Vanta Labs: code [[contact.custom_properties.vl_winback_code]] takes 15% off until [[contact.custom_properties.vl_winback_ends]]. New batch reports are on the site. ${smsLink("/products", "win-back")}`),
          wait("w3", 30, "d"),
          email("winback-2", "winback-2", "Last note from us", "Your code is valid until it expires."),
        ]),
      ],
      exitConditions: [{ event: "placed order", origin: "api" }],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 180, units: "d" } } },
    };
  },

  sunset: () => {
    counter = 0;
    const ids = created();
    const segmentID = ids.segments?.["vl-unengaged-120"];
    if (!segmentID) throw new Error("segment vl-unengaged-120 has not been created yet");
    const ask = email("sunset", "sunset", "Do you want to keep hearing from us?", "One click keeps you on the list.");
    return {
      name: "VL · Sunset",
      trigger: { condition: { event: "entered segment", origin: "omnisend", filterGroups: [{ logicalOperator: "and", filters: [{ field: "segment_id", operator: "eq", value: segmentID }] }] } },
      blocks: [
        ask,
        wait("w1", 7, "d"),
        splitOnClick("clicked", ask.temporaryID, [tag("engaged", "engaged"), tag("unsunset", "sunset", true)], [tag("sunset", "sunset")]),
      ],
      settings: { sendingThresholds: thresholds, frequencyLimiter: { mode: "interval", duration: { amount: 180, units: "d" } } },
    };
  },
};

export const AUTOMATION_KEYS = Object.keys(AUTOMATIONS);
