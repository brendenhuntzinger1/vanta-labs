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
