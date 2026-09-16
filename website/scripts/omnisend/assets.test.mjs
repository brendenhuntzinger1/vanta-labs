// Pins the Omnisend asset generator: template set, required dynamic sections,
// grant links, copy rules, code-card placement, subjects and the SMS catalogue.
// Runs offline; nothing here touches the Omnisend API.
import { describe, expect, it } from "vitest";
import { SUBJECTS, TEMPLATES, TEMPLATE_KEYS } from "./templates.mjs";
import { SMS } from "./sms.mjs";

const GRANT_LINK = "/api/email/omnisend-link?t=[[contact.custom_properties.vl_link]]&e=[[contact.email]]&";
const GIFT_LINK = "[[contact.custom_properties.vl_recovery_gift_link]]";

const EXPECTED_KEYS = [
  "welcome-1", "welcome-2", "welcome-3",
  "cart-1", "cart-2", "cart-3-gift-code", "cart-3-gift", "cart-3-code", "cart-3-plain",
  "checkout-1", "checkout-2", "checkout-3-gift-code", "checkout-3-gift", "checkout-3-code", "checkout-3-plain",
  "browse-1", "post-purchase-1", "post-purchase-2", "replenishment",
  "winback-1", "winback-2", "winback-2-nocode", "sunset",
  "new-product", "promotion", "promotion-final-day", "vip-milestone", "repeat-customer",
  "campaign-batch-report", "campaign-restock",
];
const REMOVED_KEYS = ["cart-3", "cart-3-nocode", "checkout-3", "checkout-3-nocode"];

/** Every block in a template, depth first, including product components. */
function blocks(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => blocks(child, out));
    return out;
  }
  if (typeof node.type === "string" && (node.text !== undefined || node.button || node.image || node.product || node.lineSpace)) out.push(node);
  for (const key of ["sections", "rows", "columns", "blocks", "components"]) if (node[key]) blocks(node[key], out);
  return out;
}

/** Every URL a recipient can click in a template. */
function hrefs(tpl) {
  const out = [];
  for (const block of blocks(tpl)) {
    if (block.button?.link) out.push(block.button.link);
    if (block.image?.link) out.push(block.image.link);
    if (block.product?.link) out.push(block.product.link);
    if (typeof block.text === "string") for (const match of block.text.matchAll(/href="([^"]+)"/g)) out.push(match[1]);
  }
  return out;
}

/** Visible copy: block text with tags stripped, button labels and alt text. */
function copy(tpl) {
  const parts = [];
  for (const block of blocks(tpl)) {
    if (typeof block.text === "string") parts.push(block.text.replace(/<[^>]+>/g, " "));
    if (block.button?.text) parts.push(block.button.text);
    if (block.image?.altText) parts.push(block.image.altText);
  }
  return parts.join("\n");
}

const EMOJI = /\p{Extended_Pictographic}/u;

function assertCopyRules(text, label) {
  expect(text, `${label} has an exclamation mark`).not.toMatch(/!/);
  expect(text, `${label} has an emoji`).not.toMatch(EMOJI);
  expect(text, `${label} says BAC Water`).not.toMatch(/BAC Water/i);
  expect(text, `${label} mentions a countdown or timer`).not.toMatch(/countdown|timer/i);
  expect(text, `${label} has a testimonial`).not.toMatch(/testimonial|customers say|reviews?\b/i);
  expect(text, `${label} implies human use`).not.toMatch(/\b(dose|dosage|dosing|take it|your body|benefits?)\b/i);
}

const rendered = Object.fromEntries(TEMPLATE_KEYS.map((key) => [key, TEMPLATES[key]()]));

describe("templates: the set", () => {
  it("exports exactly the keys the automations and campaigns need", () => {
    expect([...TEMPLATE_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const key of REMOVED_KEYS) expect(TEMPLATES[key]).toBeUndefined();
  });

  it("names every template VL <key>", () => {
    for (const key of TEMPLATE_KEYS) expect(rendered[key].name).toBe(`VL ${key}`);
  });

  it("frames every template with the universal header and footer", () => {
    for (const key of TEMPLATE_KEYS) {
      const layouts = rendered[key].sections.filter((section) => section.type === "universal_layout").map((section) => section.settings.universalLayoutID);
      expect(layouts, key).toEqual(["6aa985ecfa261ac55e04bae3", "6aa985f7c29076c61d3838b1"]);
    }
  });
});

describe("templates: dynamic sections", () => {
  it("gives every cart, checkout and browse template the abandoned-products section", () => {
    for (const key of TEMPLATE_KEYS.filter((k) => /^(cart|checkout|browse)-/.test(k))) {
      const types = rendered[key].sections.map((section) => section.type);
      expect(types, key).toContain("product_cart_recovery");
    }
  });

  it("gives the announcement, replenishment and cross-sell emails a product section", () => {
    for (const key of ["new-product", "replenishment", "post-purchase-2", "campaign-batch-report", "campaign-restock"]) {
      const section = rendered[key].sections.find((s) => s.type === "product_recommender");
      expect(section, key).toBeDefined();
      expect(section.productRecommender?.type, key).toBeTruthy();
      expect(["newest", "popular", "mostViewed"], key).toContain(section.productRecommender.fallbackType);
    }
  });

  it("builds every product slot from role-tagged components", () => {
    for (const key of TEMPLATE_KEYS) {
      for (const block of blocks(rendered[key]).filter((b) => b.type === "product")) {
        const roles = (block.components ?? []).map((c) => c.role);
        expect(roles, key).toEqual(expect.arrayContaining(["product_image", "product_title", "product_prices", "product_button"]));
      }
    }
  });
});

describe("templates: links, images and actions", () => {
  it("routes every link through the grant route, except the store-built gift claim URL", () => {
    for (const key of TEMPLATE_KEYS) {
      for (const href of hrefs(rendered[key])) {
        if (href === "[[unsubscribe_link]]" || href.startsWith("mailto:") || href === GIFT_LINK) continue;
        expect(href, `${key}: ${href}`).toContain(GRANT_LINK);
        expect(href, `${key}: ${href}`).toContain("utm_medium=email");
      }
    }
  });

  it("gives every image alt text", () => {
    for (const key of TEMPLATE_KEYS) {
      for (const block of blocks(rendered[key]).filter((b) => b.type === "image")) expect(block.image.altText, key).toMatch(/\S/);
    }
  });

  it("has exactly one primary button outside product slots", () => {
    for (const key of TEMPLATE_KEYS) {
      const primary = blocks(rendered[key]).filter((b) => b.type === "button" && !b.role && b.stylePresetID === "primary_button");
      expect(primary.length, key).toBe(1);
    }
  });

  it("uses only the validator-accepted style values", () => {
    const json = JSON.stringify(rendered);
    expect(json).not.toMatch(/"letterSpacing":"[^"]*(em|%)"/);
    expect(json).not.toMatch(/"textDecoration":"none"/);
    expect(json).not.toContain('"filter"');
  });
});

describe("templates: copy", () => {
  it("follows the copy rules in every template", () => {
    for (const key of TEMPLATE_KEYS) assertCopyRules(copy(rendered[key]), key);
  });

  it("keeps the recovery code to the variants the split guarantees", () => {
    const withCode = TEMPLATE_KEYS.filter((key) => JSON.stringify(rendered[key]).includes("vl_recovery_code"));
    expect(withCode.sort()).toEqual(["cart-3-code", "cart-3-gift-code", "checkout-3-code", "checkout-3-gift-code"]);
    for (const key of withCode) expect(JSON.stringify(rendered[key])).toContain("[[contact.custom_properties.vl_recovery_percent]]% off");
  });

  it("keeps the gift card to the variants the split guarantees", () => {
    const withGift = TEMPLATE_KEYS.filter((key) => JSON.stringify(rendered[key]).includes("vl_recovery_gift"));
    expect(withGift.sort()).toEqual(["cart-3-gift", "cart-3-gift-code", "checkout-3-gift", "checkout-3-gift-code"]);
    for (const key of withGift) {
      const json = JSON.stringify(rendered[key]);
      expect(json, key).toContain("[[contact.custom_properties.vl_recovery_gift]]");
      expect(json, key).toContain("on any order of [[contact.custom_properties.vl_recovery_gift_min]] or more");
      expect(json, key).toContain("[[contact.custom_properties.vl_recovery_gift_ends]]");
      expect(hrefs(rendered[key]), key).toContain(GIFT_LINK);
    }
  });

  it("makes the plain final reminder a real reminder with no incentive", () => {
    for (const key of ["cart-3-plain", "checkout-3-plain"]) {
      const json = JSON.stringify(rendered[key]);
      expect(json, key).not.toMatch(/vl_recovery|% off|code/i);
      expect(json, key).toContain("product_cart_recovery");
    }
  });

  it("puts the welcome code only where the welcome upsert guarantees it", () => {
    const withWelcome = TEMPLATE_KEYS.filter((key) => JSON.stringify(rendered[key]).includes("vl_welcome_code"));
    expect(withWelcome.sort()).toEqual(["welcome-1", "welcome-3"]);
  });

  it("puts the win-back code only in the split-guaranteed second email", () => {
    const withWinback = TEMPLATE_KEYS.filter((key) => JSON.stringify(rendered[key]).includes("vl_winback_code"));
    expect(withWinback).toEqual(["winback-2"]);
    expect(JSON.stringify(rendered["winback-1"])).not.toMatch(/vl_winback|% off/);
    expect(JSON.stringify(rendered["winback-2-nocode"])).not.toMatch(/vl_winback|% off/);
  });

  it("writes the final-day promotion with one honest deadline line", () => {
    const text = copy(rendered["promotion-final-day"]);
    expect(text).toContain("ends today at 11:59 PM ET");
    expect(text.match(/11:59 PM ET/g)).toHaveLength(1);
  });

  it("thanks a repeat customer by order count with no discount", () => {
    const json = JSON.stringify(rendered["vip-milestone"]);
    expect(json).toContain("[[contact.custom_properties.vl_orders]]");
    expect(json).not.toMatch(/vl_(welcome|winback|recovery)|% off/);
    expect(JSON.stringify(rendered["repeat-customer"])).not.toMatch(/vl_(welcome|winback|recovery)|% off/);
  });

  it("says Recon Water, never BAC Water, and frames research use", () => {
    const all = TEMPLATE_KEYS.map((key) => copy(rendered[key])).join("\n");
    expect(all).not.toMatch(/BAC Water/i);
    expect(all.toLowerCase()).toContain("research");
  });
});

describe("SUBJECTS", () => {
  it("covers every template with a subject and a preview that need no name", () => {
    expect(Object.keys(SUBJECTS).sort()).toEqual([...TEMPLATE_KEYS].sort());
    for (const [key, entry] of Object.entries(SUBJECTS)) {
      expect(entry.subject, key).toMatch(/\S/);
      expect(entry.preview, key).toMatch(/\S/);
      expect(entry.subject.length, key).toBeLessThanOrEqual(80);
      expect(entry.preview.length, key).toBeLessThanOrEqual(120);
      assertCopyRules(`${entry.subject}\n${entry.preview}`, `subject ${key}`);
      expect(`${entry.subject} ${entry.preview}`, key).not.toMatch(/\[\[contact\.first_name|\[\[contact\.custom_properties\.vl_(welcome|winback|recovery)_code/);
    }
  });
});

describe("SMS catalogue", () => {
  const SHORTENED = "https://omni.sn/xxxxxxxx"; // what a shortened link costs on the wire
  const link = /https:\/\/www\.vantalabsresearch\.com\/api\/email\/omnisend-link\?[^\s]+/g;

  it("has the seven texts", () => {
    expect(Object.keys(SMS).sort()).toEqual(["cart", "checkout", "promotion", "promotion-final-day", "restock", "welcome", "winback"]);
  });

  it("brands, opts out, links through the grant route and stays short", () => {
    for (const [key, entry] of Object.entries(SMS)) {
      expect(entry.text, key).toMatch(/^Vanta Labs: /);
      expect(entry.text, key).toMatch(/ Reply STOP to opt out\.$/);
      expect(entry.whenUsed, key).toMatch(/\S/);
      assertCopyRules(entry.text, `sms ${key}`);
      const links = entry.text.match(link) ?? [];
      expect(links.length, key).toBe(1);
      expect(links[0], key).toContain(GRANT_LINK);
      expect(links[0], key).toContain("utm_medium=sms");
      expect(entry.text.replace(link, SHORTENED).length, key).toBeLessThanOrEqual(160);
    }
  });

  it("never puts a code in a text, because a text cannot be conditional", () => {
    for (const [key, entry] of Object.entries(SMS)) expect(entry.text, key).not.toMatch(/vl_(welcome|winback|recovery)_code|% off/);
    expect(SMS.welcome.text).toMatch(/email/i);
    expect(SMS.winback.text).toMatch(/email/i);
  });

  it("keeps the final-day text to the same honest deadline", () => {
    expect(SMS["promotion-final-day"].text).toContain("ends today at 11:59 PM ET");
  });
});

describe("automations", () => {
  const THRESHOLDS = { email: "subscribed", sms: "subscribed" };
  let AUTOMATIONS, AUTOMATION_KEYS, created, segments, smsBody, STOP_SENTENCE;
  const load = async () => {
    ({ AUTOMATIONS, AUTOMATION_KEYS } = await import("./automations.mjs"));
    ({ smsBody, STOP_SENTENCE } = await import("./sms.mjs"));
    const { readFileSync } = await import("node:fs");
    created = JSON.parse(readFileSync(new URL("./assets/created.json", import.meta.url), "utf8"));
    segments = JSON.parse(readFileSync(new URL("./assets/segments.json", import.meta.url), "utf8"));
  };

  /** A delay may only end a sequence when the enclosing split has downstream siblings. */
  function noTrailingDelay(blocks, hasDownstream, path) {
    blocks.forEach((block, index) => {
      const last = index === blocks.length - 1;
      if (block.type === "delay") expect(last && !hasDownstream, `${path}[${index}] ends with a delay`).toBe(false);
      if (block.type === "split") {
        noTrailingDelay(block.split.trueBlocks ?? [], hasDownstream || !last, `${path}[${index}].true`);
        noTrailingDelay(block.split.falseBlocks ?? [], hasDownstream || !last, `${path}[${index}].false`);
      }
    });
  }
  const emailOf = (block) => block.action.sendEmail;
  const segSplit = (block) => block.split.filterGroup.filters[0];
  const delay = (block) => `${block.delay.duration.amount}${block.delay.duration.units}`;

  it("builds the eight flows with thresholds, a limiter and no trailing delay", async () => {
    await load();
    expect(AUTOMATION_KEYS).toEqual(["welcome", "abandoned-cart", "abandoned-checkout", "browse-abandonment", "post-purchase", "replenishment", "win-back", "sunset"]);
    for (const key of AUTOMATION_KEYS) {
      const flow = AUTOMATIONS[key]();
      expect(flow.settings.sendingThresholds, key).toEqual(THRESHOLDS);
      expect(flow.settings.frequencyLimiter?.mode, key).toMatch(/^(once|interval)$/);
      noTrailingDelay(flow.blocks, false, key);
      const ids = JSON.stringify(flow).match(/"temporaryID":"([^"]+)"/g);
      expect(new Set(ids).size, `${key} temporaryIDs unique`).toBe(ids.length);
    }
  });

  it("sends every email from created.json with its SUBJECTS entry and every text from the SMS catalogue", async () => {
    await load();
    const walk = (blocks, out) => { for (const b of blocks) { if (b.type === "action") out.push(b); if (b.type === "split") { walk(b.split.trueBlocks ?? [], out); walk(b.split.falseBlocks ?? [], out); } } return out; };
    for (const key of AUTOMATION_KEYS) {
      for (const block of walk(AUTOMATIONS[key]().blocks, [])) {
        if (block.action.type === "sendEmail") {
          const email = block.action.sendEmail;
          const templateKey = Object.keys(created).find((k) => created[k] === email.templateID);
          expect(templateKey, `${key}: ${email.templateID}`).toBeDefined();
          expect(email.subject, key).toBe(SUBJECTS[templateKey].subject);
          expect(email.preheader, key).toBe(SUBJECTS[templateKey].preview);
          expect(email.language, key).toBe("en_US");
          expect(email.senderName, key).toBe("Vanta Labs");
        }
        if (block.action.type === "sendSms") {
          const sms = block.action.sendSms;
          expect(sms.message, key).toMatch(/^Vanta Labs: /);
          expect(sms.message, key).not.toMatch(/vl_(welcome|winback|recovery)_code|% off/);
          expect(sms.compliance.stopKeywordText, key).toBe(STOP_SENTENCE);
          expect(sms.compliance.unsubscribeLinkText, key).toContain("[[unsubscribe_link]]");
          expect(Object.values(SMS).some((entry) => smsBody(Object.keys(SMS).find((k) => SMS[k] === entry)) === sms.message), key).toBe(true);
        }
      }
    }
  });

  it("welcome: E1, SMS without the code, 2d, E2, 3d, E3, once per contact", async () => {
    await load();
    const flow = AUTOMATIONS.welcome();
    expect(flow.trigger).toEqual({ condition: { event: "subscribed to marketing" } });
    const [e1, sms, d1, e2, d2, e3] = flow.blocks;
    expect(emailOf(e1).templateID).toBe(created["welcome-1"]);
    expect(sms.action.type).toBe("sendSms");
    expect(delay(d1)).toBe("2d");
    expect(emailOf(e2).templateID).toBe(created["welcome-2"]);
    expect(delay(d2)).toBe("3d");
    expect(emailOf(e3).templateID).toBe(created["welcome-3"]);
    expect(flow.settings.frequencyLimiter).toEqual({ mode: "once" });
  });

  it.each([
    ["abandoned-cart", "added product to cart", "cart", ["placed order", "started checkout"]],
    ["abandoned-checkout", "started checkout", "checkout", ["placed order"]],
  ])("%s: E1, 23h, E2, 3h, SMS, 45h, then the gift and code splits", async (key, event, kind, exits) => {
    await load();
    const flow = AUTOMATIONS[key]();
    expect(flow.trigger).toEqual({ condition: { event, origin: "api" }, inactivitySettings: { duration: { amount: 1, units: "h" } } });
    const [e1, d1, e2, d2, sms, d3, split] = flow.blocks;
    expect(flow.blocks).toHaveLength(7);
    expect(emailOf(e1).templateID).toBe(created[`${kind}-1`]);
    expect(delay(d1)).toBe("23h");
    expect(emailOf(e2).templateID).toBe(created[`${kind}-2`]);
    expect(delay(d2)).toBe("3h");
    expect(sms.action.type).toBe("sendSms");
    expect(delay(d3)).toBe("45h");
    expect(segSplit(split)).toEqual({ type: "contact", field: "segmentID", operator: "eq", value: segments["vl-recovery-gift-ready"] });
    const [giftSplit] = split.split.trueBlocks;
    const [noGiftSplit] = split.split.falseBlocks;
    for (const inner of [giftSplit, noGiftSplit]) expect(segSplit(inner)).toEqual({ type: "contact", field: "segmentID", operator: "eq", value: segments["vl-recovery-code-ready"] });
    expect(emailOf(giftSplit.split.trueBlocks[0]).templateID).toBe(created[`${kind}-3-gift-code`]);
    expect(emailOf(giftSplit.split.falseBlocks[0]).templateID).toBe(created[`${kind}-3-gift`]);
    expect(emailOf(noGiftSplit.split.trueBlocks[0]).templateID).toBe(created[`${kind}-3-code`]);
    expect(emailOf(noGiftSplit.split.falseBlocks[0]).templateID).toBe(created[`${kind}-3-plain`]);
    expect(flow.exitConditions).toEqual(exits.map((e) => ({ event: e, origin: "api" })));
    expect(flow.settings.frequencyLimiter).toEqual({ mode: "interval", duration: { amount: 7, units: "d" } });
  });

  it("browse-abandonment: one email after 4h of quiet, exits on cart, checkout and order, once per 7 days", async () => {
    await load();
    const flow = AUTOMATIONS["browse-abandonment"]();
    expect(flow.trigger).toEqual({ condition: { event: "viewed product", origin: "api" }, inactivitySettings: { duration: { amount: 4, units: "h" } } });
    expect(flow.blocks).toHaveLength(1);
    expect(emailOf(flow.blocks[0]).templateID).toBe(created["browse-1"]);
    expect(flow.exitConditions).toEqual([{ event: "added product to cart", origin: "api" }, { event: "started checkout", origin: "api" }, { event: "placed order", origin: "api" }]);
    expect(flow.settings.frequencyLimiter).toEqual({ mode: "interval", duration: { amount: 7, units: "d" } });
  });

  it("post-purchase: 1d, E1, 9d, E2, then the repeat-customer thank-you", async () => {
    await load();
    const flow = AUTOMATIONS["post-purchase"]();
    expect(flow.trigger).toEqual({ condition: { event: "paid for order", origin: "api" } });
    const [d1, e1, d2, e2, split] = flow.blocks;
    expect(delay(d1)).toBe("1d");
    expect(emailOf(e1).templateID).toBe(created["post-purchase-1"]);
    expect(delay(d2)).toBe("9d");
    expect(emailOf(e2).templateID).toBe(created["post-purchase-2"]);
    expect(segSplit(split).value).toBe(segments["vl-repeat-customers"]);
    expect(emailOf(split.split.trueBlocks[0]).templateID).toBe(created["vip-milestone"]);
    expect(split.split.falseBlocks).toEqual([]);
  });

  it("replenishment: 45d, then only those who have not bought again", async () => {
    await load();
    const flow = AUTOMATIONS.replenishment();
    const [d1, split] = flow.blocks;
    expect(delay(d1)).toBe("45d");
    expect(segSplit(split).value).toBe(segments["vl-bought-30d"]);
    expect(split.split.trueBlocks).toEqual([]);
    expect(emailOf(split.split.falseBlocks[0]).templateID).toBe(created["replenishment"]);
  });

  it("win-back: 60d, E1 without a code, 1d, SMS, 30d, then the code split", async () => {
    await load();
    const flow = AUTOMATIONS["win-back"]();
    expect(flow.trigger).toEqual({ condition: { event: "paid for order", origin: "api" } });
    const [d1, e1, d2, sms, d3, split] = flow.blocks;
    expect(delay(d1)).toBe("60d");
    expect(emailOf(e1).templateID).toBe(created["winback-1"]);
    expect(delay(d2)).toBe("1d");
    expect(sms.action.type).toBe("sendSms");
    expect(delay(d3)).toBe("30d");
    expect(segSplit(split).value).toBe(segments["vl-winback-ready"]);
    expect(emailOf(split.split.trueBlocks[0]).templateID).toBe(created["winback-2"]);
    expect(emailOf(split.split.falseBlocks[0]).templateID).toBe(created["winback-2-nocode"]);
    expect(flow.exitConditions).toEqual([{ event: "paid for order", origin: "api" }]);
  });

  it("sunset: one email on entering the unengaged segment, then tag by click", async () => {
    await load();
    const flow = AUTOMATIONS.sunset();
    expect(flow.trigger.condition.event).toBe("entered segment");
    expect(flow.trigger.condition.filterGroups[0].filters[0].value).toBe(segments["vl-unengaged-120"]);
    const [ask, d1, split] = flow.blocks;
    expect(emailOf(ask).templateID).toBe(created["sunset"]);
    expect(delay(d1)).toBe("7d");
    expect(split.split.filterGroup.filters[0]).toMatchObject({ type: "message", field: "blockID", operator: "clickedEmail", value: ask.temporaryID });
    expect(split.split.trueBlocks.map((b) => [b.action.type, (b.action.addTag ?? b.action.removeTag).value])).toEqual([["addTag", "engaged"], ["removeTag", "sunset"]]);
    expect(split.split.falseBlocks.map((b) => [b.action.type, b.action.addTag.value])).toEqual([["addTag", "sunset"]]);
  });
});

describe("segments: recovery readiness", () => {
  it("defines the two split segments the abandonment automations need", async () => {
    const { SEGMENTS, PROPERTY_SEGMENTS } = await import("./segments.mjs");
    const gift = PROPERTY_SEGMENTS["vl-recovery-gift-ready"]();
    const code = PROPERTY_SEGMENTS["vl-recovery-code-ready"]();
    expect(gift.name).toBe("VL · Recovery gift ready");
    expect(code.name).toBe("VL · Recovery code ready");
    expect(gift.conditionGroups[0].conditions[0]).toEqual({ entity: "contact", junction: "and", filters: [{ property: "custom", name: "vl_recovery_gift_ready", valueType: "text", operator: "anyOf", value: ["yes"] }] });
    expect(code.conditionGroups[0].conditions[0]).toEqual({ entity: "contact", junction: "and", filters: [{ property: "custom", name: "vl_recovery_ready", valueType: "text", operator: "anyOf", value: ["yes"] }] });
    expect(SEGMENTS["vl-recovery-gift-ready"]).toBe(PROPERTY_SEGMENTS["vl-recovery-gift-ready"]);
    const winback = PROPERTY_SEGMENTS["vl-winback-ready"]();
    expect(winback.name).toBe("VL · Win-back code ready");
    expect(winback.conditionGroups[0].conditions[0].filters[0]).toEqual({ property: "custom", name: "vl_winback_ready", valueType: "text", operator: "anyOf", value: ["yes"] });
  });
});

describe("form", () => {
  const LINE_HEIGHTS = ["100%", "115%", "125%", "150%", "200%"];
  const BUTTON_STYLE_KEYS = ["borderRadius", "borderStyle", "borderWidth", "color", "fontFamily", "fontSize", "fontStyle", "fontWeight", "textDecoration"];

  /** Every node of the form content tree, depth first. */
  function nodes(node, out = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((child) => nodes(child, out));
      return out;
    }
    out.push(node);
    Object.values(node).forEach((child) => nodes(child, out));
    return out;
  }

  // A block names its type and carries the config of that type (a text block carries `text`);
  // a button's own config object also has a `type`, so it is excluded by the second test.
  const isBlock = (n) => typeof n.type === "string" && (n.type === "text" ? typeof n.text === "string" : typeof n[n.type] === "object");
  const formBlocks = (f) => nodes(f.content).filter(isBlock);
  const strings = (f) => nodes(f.content).flatMap((n) => Object.values(n).filter((v) => typeof v === "string"));

  it("matches the post_forms schema: no client ids, stylePresetID, shorthand-free padding", async () => {
    const { form } = await import("./form.mjs");
    const f = form();
    expect(f.displayType).toBe("popup");
    // Presets carry their well-known ids; the content tree must carry none.
    for (const n of nodes([...f.content.steps, f.content.successStep, f.content.subscribedStep])) {
      expect(n.id, "server assigns ids; the request must not carry any").toBeUndefined();
      expect(n.stylePresetId, "the schema key is stylePresetID").toBeUndefined();
      expect(n.styleProperties?.padding, "padding is four sides, not a shorthand").toBeUndefined();
      expect(n.styleProperties?.letterSpacing).toBeUndefined();
    }
    for (const preset of f.content.generalSettings.textPresets) {
      expect(LINE_HEIGHTS).toContain(preset.styles.lineHeight);
      expect(preset.styles.letterSpacing).toBeUndefined();
    }
    for (const preset of f.content.generalSettings.buttonPresets) {
      for (const key of BUTTON_STYLE_KEYS) expect(preset.styles[key], `${preset.id}.${key}`).toBeDefined();
      expect(preset.styles.border, "border shorthand is not a preset style").toBeUndefined();
      expect(["underline", "none"]).toContain(preset.styles.textDecoration);
    }
    // The validator refuses rgba colours, font stacks it does not ship, and input blocks without styleProperties.
    for (const n of nodes(f.content.generalSettings)) {
      for (const [key, value] of Object.entries(n)) {
        if (/color/i.test(key)) expect(value, key).toMatch(/^#[0-9a-f]{6}$/i);
        if (key === "fontFamily") expect(value).toBe("Inter, Helvetica Neue, Helvetica, Arial, sans-serif");
      }
    }
    for (const b of formBlocks(f)) expect(b.styleProperties, `${b.type} needs styleProperties`).toBeDefined();
    expect(f.content.generalSettings.textPresets.map((p) => p.id)).toEqual(["heading_large", "heading_medium", "heading_small", "paragraph", "footnote"]);
    expect(f.content.generalSettings.buttonPresets.map((p) => p.id)).toEqual(["primary_button", "secondary_button", "tertiary_button"]);
    expect(f.content.generalSettings.body).toMatchObject({ borderStyle: "solid", borderWidth: expect.any(String), borderRadius: expect.any(String) });
    expect(f.targeting.device, "device is a single enum value; omit it to target both").toBeUndefined();
    expect(f.targeting.location.includes).toEqual([{ code: "US", name: "United States" }, { code: "CA", name: "Canada" }]);
    expect(f.targeting.source.excludes).toEqual(["omnisendCommunication"]);
    for (const step of [...f.content.steps, f.content.successStep, f.content.subscribedStep]) {
      expect(step.sections).toHaveLength(1);
      expect(step.sections[0].rows[0].columns[0].width).toBe("100%");
    }
  });

  it("collects email on step one and optional SMS consent with the TCPA sentence on step two", async () => {
    const { form } = await import("./form.mjs");
    const f = form();
    const step1 = formBlocks({ content: f.content.steps[0] });
    const step2 = formBlocks({ content: f.content.steps[1] });
    expect(step1.some((b) => b.type === "emailField" && b.emailField.isRequired)).toBe(true);
    expect(step1.filter((b) => b.button?.type === "submit")).toHaveLength(1);
    expect(step2.some((b) => b.type === "phoneNumberField" && b.phoneNumberField.isRequired === false)).toBe(true);
    const legal = step2.find((b) => b.type === "legal").legal;
    expect(legal.type).toBe("tcpa");
    expect(legal.link).toBe("https://www.vantalabsresearch.com/legal/privacy");
    expect(legal.label).toBeTruthy();
    expect(legal.requiredMessage).toBeTruthy();
    for (const needle of ["Vanta Labs", "Message frequency varies", "Message and data rates may apply", "STOP", "HELP", "not a condition of purchase"]) {
      expect(legal.description).toContain(needle);
    }
    expect(step2.some((b) => b.button?.type === "nextStep")).toBe(true);
  });

  it("follows the copy rules and never claims a discount it cannot mint", async () => {
    const { form } = await import("./form.mjs");
    const f = form();
    const copy = strings(f).join("\n");
    expect(copy).not.toMatch(/!/);
    expect(copy).not.toMatch(/BAC Water/i);
    expect(copy).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(copy).not.toMatch(/\d+% off/i);
    expect(copy).toMatch(/research use only/i);
    expect(formBlocks(f).some((b) => b.type === "discount")).toBe(false);
    expect(f.content.successStep.sections[0].rows[0].columns[0].blocks.find((b) => b.button).button.link).toMatch(/^https:\/\/www\.vantalabsresearch\.com\//);
  });
});
