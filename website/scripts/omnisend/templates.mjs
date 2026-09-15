import {
  CLAIMS, IMAGES, PALETTE, button, card, eyebrow, footnote, heading, hexId, image, layoutRef, link,
  productSection, section, spacer, template, text,
} from "./lib.mjs";

/** Universal layouts created 2026-09-15 (post_email_universal_layouts). */
export const LAYOUTS = { header: "6aa985ecfa261ac55e04bae3", footer: "6aa985f7c29076c61d3838b1" };

/** The three per-contact codes the store mints (spec §3.4). Percentages here MUST match CONTACT_CODE_OFFERS in src/lib/marketing/omnisend/codes.ts. */
const CODES = {
  welcome: { prop: "vl_welcome_code", ends: "vl_welcome_ends", ready: "vl_welcome_ready", percent: 10, terms: "One use, tied to this address, on a first order." },
  winback: { prop: "vl_winback_code", ends: "vl_winback_ends", ready: "vl_winback_ready", percent: 15, terms: "One use, tied to this address." },
  recovery: { prop: "vl_recovery_code", ends: "vl_recovery_ends", ready: "vl_recovery_ready", percent: 10, terms: "One use, tied to this address." },
};

/**
 * A section shown only when the contact carries the code. Omnisend's content
 * filter hides the whole section when the property is empty, so nobody ever
 * sees a blank code line.
 */
function codeCard(seed, kind, campaign) {
  const code = CODES[kind];
  const s = section(seed, [
    eyebrow(`${seed}:eyebrow`, "Your code"),
    text(`${seed}:code`, `[[contact.custom_properties.${code.prop}]]`, { preset: "mono", padding: "0px 32px 8px" }),
    text(`${seed}:terms`, `${code.percent}% off. Valid until [[contact.custom_properties.${code.ends}]]. ${code.terms}`, { padding: "0px 32px 4px" }),
    button(`${seed}:button`, "Use the code", link("/products", { campaign, content: "code" }), { padding: "12px 32px 24px" }),
  ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` });
  // No content filter: conditional sections are a paid Omnisend feature this
  // account does not have. The card is therefore unconditional, and the store
  // guarantees the code exists before any email that shows it can fire —
  // welcome codes are minted in the same contact upsert that triggers the
  // flow, recovery codes when the cart or checkout event is sent, and win-back
  // codes by the reconcile sweep well before the 60-day email (spec §3.4).
  return s;
}

function frame(key, sections) {
  return template(`VL ${key}`, [layoutRef(`${key}:header`, LAYOUTS.header), ...sections, spacerSection(`${key}:tail`), layoutRef(`${key}:footer`, LAYOUTS.footer)]);
}

function spacerSection(seed, height = 12) {
  return section(seed, [spacer(`${seed}:space`, height)]);
}

function hero(seed, { kicker, title, lead, extra = [], cta, secondary, showImage = false, campaign }) {
  const blocks = [];
  if (showImage) blocks.push(image(`${seed}:image`, IMAGES.hero, { alt: "A Vanta Labs vial on a dark field", width: 536, padding: "0px 32px 22px" }));
  blocks.push(eyebrow(`${seed}:eyebrow`, kicker));
  blocks.push(heading(`${seed}:heading`, title));
  blocks.push(text(`${seed}:lead`, lead));
  extra.forEach((line, index) => blocks.push(text(`${seed}:extra:${index}`, line)));
  if (cta) blocks.push(button(`${seed}:cta`, cta.label, link(cta.path, { campaign, content: "primary" })));
  if (secondary) blocks.push(button(`${seed}:secondary`, secondary.label, link(secondary.path, { campaign, content: "secondary" }), { preset: "tertiary_button", padding: "0px 32px 20px" }));
  return card(seed, blocks);
}

const COA_LINE = "Every production batch is tested by an independent laboratory and its Certificate of Analysis is filed in a public library you can search by product, batch or lot number.";

export const TEMPLATES = {
  "welcome-1": () => frame("welcome-1", [
    hero("welcome-1:hero", {
      kicker: "Welcome", title: "Precision, in every vial.",
      lead: `Vanta Labs Research supplies laboratory research materials. ${COA_LINE}`,
      extra: [`Two things worth knowing before a first order. ${CLAIMS.fulfilment} Every listing shows its current batch number and links to the report.`],
      cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "Read a batch report", path: "/coa-library" },
      showImage: true, campaign: "welcome",
    }),
    spacerSection("welcome-1:gap"),
    codeCard("welcome-1:code", "welcome", "welcome"),
  ]),

  "welcome-2": () => frame("welcome-2", [
    hero("welcome-2:hero", {
      kicker: "Documentation", title: "Anyone can print a label. We publish the proof.",
      lead: "Every lot is tested by a third-party laboratory. The report is filed under its batch number in the COA library, where you can read it before you order and again after it arrives.",
      extra: ["Identity is confirmed by mass spectrometry, so the exact compound and molecular weight of every lot are on the report. The figures live on the certificate, not in this email."],
      cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "Browse the catalogue", path: "/products" },
      campaign: "welcome",
    }),
  ]),

  "welcome-3": () => frame("welcome-3", [
    hero("welcome-3:hero", {
      kicker: "Ordering", title: "What happens after you order.",
      lead: CLAIMS.fulfilment,
      extra: [`${CLAIMS.destinations} ${CLAIMS.tracking}`, "Checkout is encrypted. Card details never touch our servers.", "Solvents and reconstitution accessories are listed under Solvents & Solutions in the catalogue."],
      cta: { label: "Browse the catalogue", path: "/products" },
      campaign: "welcome",
    }),
    spacerSection("welcome-3:gap"),
    codeCard("welcome-3:code", "welcome", "welcome"),
  ]),

  "cart-1": () => frame("cart-1", [
    hero("cart-1:hero", {
      kicker: "Your cart", title: "Still saved, whenever you are ready.",
      lead: "The items below are held in your cart. Batch numbers and reports are on each product page.",
      cta: { label: "Return to cart", path: "/cart" }, campaign: "abandoned-cart",
    }),
    productSection("cart-1:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-cart" }),
  ]),

  "cart-2": () => frame("cart-2", [
    hero("cart-2:hero", {
      kicker: "Documentation", title: "Before you decide, read the report.",
      lead: COA_LINE,
      extra: ["Your cart is still saved."],
      cta: { label: "Return to cart", path: "/cart" }, secondary: { label: "Open the COA library", path: "/coa-library" }, campaign: "abandoned-cart",
    }),
    productSection("cart-2:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-cart" }),
  ]),

  "cart-3": () => frame("cart-3", [
    hero("cart-3:hero", {
      kicker: "Your cart", title: "One more note, then we will leave it with you.",
      lead: "Your cart is still saved. If you want to complete it, the code below is valid until the date shown.",
      cta: { label: "Return to cart", path: "/cart" }, campaign: "abandoned-cart",
    }),
    spacerSection("cart-3:gap"),
    codeCard("cart-3:code", "recovery", "abandoned-cart"),
    productSection("cart-3:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-cart" }),
  ]),

  "cart-3-nocode": () => frame("cart-3-nocode", [
    hero("cart-3-nocode:hero", {
      kicker: "Your cart", title: "One more note, then we will leave it with you.",
      lead: "Your cart is still saved. Batch numbers and reports are on each product page, and support can answer anything the report does not.",
      cta: { label: "Return to cart", path: "/cart" }, campaign: "abandoned-cart",
    }),
    productSection("cart-3-nocode:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-cart" }),
  ]),

  "checkout-1": () => frame("checkout-1", [
    hero("checkout-1:hero", {
      kicker: "Your checkout", title: "Finish when you are ready.",
      lead: "Your checkout is saved with the items below. Nothing has been charged.",
      cta: { label: "Return to checkout", path: "/checkout" }, campaign: "abandoned-checkout",
    }),
    productSection("checkout-1:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-checkout" }),
  ]),

  "checkout-2": () => frame("checkout-2", [
    hero("checkout-2:hero", {
      kicker: "Your checkout", title: "Still here when you are.",
      lead: `${CLAIMS.fulfilment} ${CLAIMS.tracking}`,
      extra: ["Checkout is encrypted. Card details never touch our servers."],
      cta: { label: "Return to checkout", path: "/checkout" }, secondary: { label: "Open the COA library", path: "/coa-library" }, campaign: "abandoned-checkout",
    }),
    productSection("checkout-2:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-checkout" }),
  ]),

  "checkout-3": () => frame("checkout-3", [
    hero("checkout-3:hero", {
      kicker: "Your checkout", title: "One more note, then we will leave it with you.",
      lead: "Your checkout is still saved. If you want to complete it, the code below is valid until the date shown.",
      cta: { label: "Return to checkout", path: "/checkout" }, campaign: "abandoned-checkout",
    }),
    spacerSection("checkout-3:gap"),
    codeCard("checkout-3:code", "recovery", "abandoned-checkout"),
    productSection("checkout-3:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-checkout" }),
  ]),

  "checkout-3-nocode": () => frame("checkout-3-nocode", [
    hero("checkout-3-nocode:hero", {
      kicker: "Your checkout", title: "One more note, then we will leave it with you.",
      lead: "Your checkout is still saved. Batch numbers and reports are on each product page, and support can answer anything the report does not.",
      cta: { label: "Return to checkout", path: "/checkout" }, campaign: "abandoned-checkout",
    }),
    productSection("checkout-3-nocode:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "abandoned-checkout" }),
  ]),

  "browse-1": () => frame("browse-1", [
    hero("browse-1:hero", {
      kicker: "Recently viewed", title: "Still there when you want it.",
      lead: "The products you viewed are below, each with its current batch number and a link to the report on its page.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "browse-abandonment",
    }),
    productSection("browse-1:products", "product_cart_recovery", { count: 3, buttonText: "View", campaign: "browse-abandonment" }),
  ]),

  "post-purchase-1": () => frame("post-purchase-1", [
    hero("post-purchase-1:hero", {
      kicker: "After your order", title: "Thank you for your order.",
      lead: `Your order is being prepared. ${CLAIMS.fulfilment} ${CLAIMS.tracking}`,
      extra: ["Every product in your order lists its batch number on the product page. Search that number in the COA library to read the certificate for your exact lot."],
      cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "post-purchase",
    }),
  ]),

  "post-purchase-2": () => frame("post-purchase-2", [
    hero("post-purchase-2:hero", {
      kicker: "Catalogue", title: "Also in the catalogue.",
      lead: "A few products chosen from what is ordered alongside yours. Every one links to its batch report.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "post-purchase",
    }),
    productSection("post-purchase-2:products", "product_recommender", { count: 3, buttonText: "View", campaign: "post-purchase", recommender: { type: "popular", fallbackType: "newest", isOutOfStockIncluded: false, purchaseExclusionDays: 30 } }),
  ]),

  "replenishment": () => frame("replenishment", [
    hero("replenishment:hero", {
      kicker: "Reorder", title: "When it is time to reorder.",
      lead: "Batches change. The current batch number for each product is on its page, with the report filed under it.",
      cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "replenishment",
    }),
    productSection("replenishment:products", "product_recommender", { count: 3, buttonText: "View", campaign: "replenishment", recommender: { type: "personalized", fallbackType: "popular", isOutOfStockIncluded: false } }),
  ]),

  "winback-1": () => frame("winback-1", [
    hero("winback-1:hero", {
      kicker: "Since your last order", title: "It has been a while.",
      lead: "New batches have been filed since your last order. If you are ordering again, the code below is valid for 14 days.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "win-back",
    }),
    spacerSection("winback-1:gap"),
    codeCard("winback-1:code", "winback", "win-back"),
    productSection("winback-1:products", "product_recommender", { count: 3, buttonText: "View", campaign: "win-back", recommender: { type: "popular", fallbackType: "newest", isOutOfStockIncluded: false } }),
  ]),

  "winback-2": () => frame("winback-2", [
    hero("winback-2:hero", {
      kicker: "Since your last order", title: "One last note.",
      lead: "Your code is valid until [[contact.custom_properties.vl_winback_ends]]. After that we will stop writing unless you order or ask us to.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "win-back",
    }),
    spacerSection("winback-2:gap"),
    codeCard("winback-2:code", "winback", "win-back"),
  ]),

  "sunset": () => frame("sunset", [
    hero("sunset:hero", {
      kicker: "Your subscription", title: "Do you want to keep hearing from us?",
      lead: "We send batch reports, restocks and occasional subscriber offers. If you would like to keep receiving them, use the button below. If we do not hear from you, this is the last one.",
      cta: { label: "Keep me on the list", path: "/?stay=1" }, campaign: "sunset",
    }),
    section("sunset:unsub", [footnote("sunset:unsub:text", `Or <a href="[[unsubscribe_link]]" style="color:${PALETTE.muted};text-decoration:underline;">unsubscribe</a> now and we will stop straight away.`, { align: "center" })]),
  ]),

  "campaign-batch-report": () => frame("campaign-batch-report", [
    hero("campaign-batch-report:hero", {
      kicker: "Batch report", title: "A new batch report is filed.",
      lead: "PRODUCT NAME — batch BATCH NUMBER, tested DATE by LAB NAME. Replace this line with the values from the published certificate, or delete it; nothing here may be stated that is not on the report.",
      extra: ["The report is filed in the COA library under its batch number."],
      cta: { label: "Read the report", path: "/coa-library" }, secondary: { label: "Browse the catalogue", path: "/products" }, campaign: "campaign",
    }),
    productSection("campaign-batch-report:products", "product_recommender", { count: 3, buttonText: "View", campaign: "campaign", recommender: { type: "newest", fallbackType: "popular", isOutOfStockIncluded: false } }),
  ]),

  "campaign-restock": () => frame("campaign-restock", [
    hero("campaign-restock:hero", {
      kicker: "Restock", title: "Back in the catalogue.",
      lead: "PRODUCT NAME is back in stock, with a new batch number and its report filed. Replace this line before sending; state stock only as the live store shows it.",
      cta: { label: "View the product", path: "/products" }, secondary: { label: "Read the report", path: "/coa-library" }, campaign: "campaign",
    }),
    productSection("campaign-restock:products", "product_recommender", { count: 3, buttonText: "View", campaign: "campaign", recommender: { type: "newest", fallbackType: "popular", isOutOfStockIncluded: false } }),
  ]),
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
export { hexId };
