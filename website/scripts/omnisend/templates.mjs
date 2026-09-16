import {
  CLAIMS, IMAGES, PALETTE, SUPPORT_EMAIL, button, card, eyebrow, footnote, heading, hexId, image, layoutRef, link,
  productSection, section, spacer, template, text,
} from "./lib.mjs";

/** Universal layouts created 2026-09-15 (post_email_universal_layouts). */
export const LAYOUTS = { header: "6aa985ecfa261ac55e04bae3", footer: "6aa985f7c29076c61d3838b1" };

/**
 * The three per-contact codes the store mints (spec §3.4). Welcome and win-back
 * percentages MUST match CONTACT_CODE_OFFERS in src/lib/marketing/omnisend/codes.ts;
 * the recovery percentage is a contact property because the store decides it
 * per cart (vl_recovery_percent).
 */
const CODES = {
  welcome: { prop: "vl_welcome_code", ends: "vl_welcome_ends", percent: "15", terms: "One use, tied to this address, on a first order." },
  winback: { prop: "vl_winback_code", ends: "vl_winback_ends", percent: "15", terms: "One use, tied to this address." },
  recovery: { prop: "vl_recovery_code", ends: "vl_recovery_ends", percent: "[[contact.custom_properties.vl_recovery_percent]]", terms: "One use, tied to this address." },
};

/** The store-built claim URL for a recovery gift. It already carries the grant, so it is not wrapped in link(). */
const GIFT_LINK = "[[contact.custom_properties.vl_recovery_gift_link]]";
/** The same for the welcome gift (welcome-gift.ts): the click sets the offer cookie and lands on the catalogue. */
const WELCOME_GIFT_LINK = "[[contact.custom_properties.vl_welcome_gift_link]]";

/**
 * The code card. Conditional sections are a paid Omnisend feature this account
 * does not have, so the card is unconditional and appears ONLY in templates an
 * automation split guarantees a code for: welcome-2-code and welcome-3 (split
 * on vl-welcome-ready; welcome-1 carries no card because the code may not
 * exist yet, and a checkout opt-in never gets one), the *-3-code and
 * *-3-gift-code abandonment variants (split on vl-recovery-code-ready) and
 * winback-2 (split on vl-winback-ready). The button is secondary so every
 * email keeps one primary action.
 */
function codeCard(seed, kind, campaign, path = "/products") {
  const code = CODES[kind];
  return section(seed, [
    eyebrow(`${seed}:eyebrow`, "Your code"),
    text(`${seed}:code`, `[[contact.custom_properties.${code.prop}]]`, { preset: "mono", padding: "0px 32px 8px" }),
    text(`${seed}:terms`, `${code.percent}% off. Valid until [[contact.custom_properties.${code.ends}]]. ${code.terms}`, { padding: "0px 32px 4px" }),
    button(`${seed}:button`, "Use the code", link(path, { campaign, content: "code" }), { preset: "secondary_button", padding: "12px 32px 24px" }),
  ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` });
}

/** The gift card: only in the *-3-gift and *-3-gift-code variants (split on vl-recovery-gift-ready). */
function giftCard(seed) {
  return section(seed, [
    eyebrow(`${seed}:eyebrow`, "Your gift"),
    text(`${seed}:gift`, "[[contact.custom_properties.vl_recovery_gift]]", { preset: "heading_small", padding: "0px 32px 8px" }),
    text(`${seed}:terms`, "Added free on any order of [[contact.custom_properties.vl_recovery_gift_min]] or more, if claimed by [[contact.custom_properties.vl_recovery_gift_ends]]. One claim, tied to this address.", { padding: "0px 32px 4px" }),
    button(`${seed}:button`, "Claim the gift", GIFT_LINK, { preset: "secondary_button", padding: "12px 32px 24px" }),
  ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` });
}

/**
 * THE WELCOME OFFER, ONE EMAIL, TWO SHAPES. The store mints a free GHK-Cu and
 * a 15% code together for a never-bought address the moment it subscribes
 * (hooks.ts onMarketingOptIn; the reconcile for pop-up sign-ups), and the
 * checkout honours ONE of them (quote-order.ts: a welcome code typed over the
 * vial withdraws the vial). So the vial leads — it is the one the owner would
 * rather give, and "free" reads bigger than a percentage on an ordinary
 * first order — and the code is offered beneath it as the alternative for a
 * larger order. The welcome-offer automation splits on vl-welcome-gift-ready,
 * so the gift card is only ever sent where the vial was minted and can ship;
 * the code-only twin carries the code alone.
 */
function welcomeOfferGiftHero(seed) {
  return card(seed, [
    image(`${seed}:image`, IMAGES.hero, { alt: "A Vanta Labs GHK-Cu vial on a dark field", width: 536, padding: "0px 32px 22px" }),
    eyebrow(`${seed}:eyebrow`, "Your welcome offer"),
    heading(`${seed}:heading`, "A free GHK-Cu with your first order."),
    text(`${seed}:lead`, "[[contact.custom_properties.vl_welcome_gift]] is added to a first order of [[contact.custom_properties.vl_welcome_gift_min]] or more when you claim it through the button below, until [[contact.custom_properties.vl_welcome_gift_ends]]. One claim, tied to this address. Its batch number and report are on the product page, like every listing."),
    button(`${seed}:cta`, "Claim the free GHK-Cu", WELCOME_GIFT_LINK),
    button(`${seed}:secondary`, "Browse the catalogue", link("/products", { campaign: "welcome-offer", content: "secondary" }), { preset: "tertiary_button", padding: "0px 32px 20px" }),
  ]);
}

/** The code, as the alternative under the vial: same card as the code card, headed as a choice. */
function welcomeAlternativeCard(seed) {
  const code = CODES.welcome;
  return section(seed, [
    eyebrow(`${seed}:eyebrow`, "Or take 15% off instead"),
    text(`${seed}:code`, `[[contact.custom_properties.${code.prop}]]`, { preset: "mono", padding: "0px 32px 8px" }),
    text(`${seed}:terms`, `${code.percent}% off a first order with this code. Valid until [[contact.custom_properties.${code.ends}]]. One use, tied to this address. The checkout honours the vial or the code, whichever you use.`, { padding: "0px 32px 4px" }),
    button(`${seed}:button`, "Use the code", link("/products", { campaign: "welcome-offer", content: "code" }), { preset: "secondary_button", padding: "12px 32px 24px" }),
  ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` });
}

function frame(key, sections) {
  return template(`VL ${key}`, [layoutRef(`${key}:header`, LAYOUTS.header), ...sections, spacerSection(`${key}:tail`), layoutRef(`${key}:footer`, LAYOUTS.footer)]);
}

function spacerSection(seed, height = 12) {
  return section(seed, [spacer(`${seed}:space`, height)]);
}

/** The hero card: eyebrow, heading, lead, extra lines, one primary button and an optional tertiary link. */
function hero(seed, { kicker, title, lead, extra = [], cta, secondary, showImage = false, campaign }) {
  const blocks = [];
  if (showImage) blocks.push(image(`${seed}:image`, IMAGES.hero, { alt: "A Vanta Labs GHK-Cu vial on a dark field", width: 536, padding: "0px 32px 22px" }));
  blocks.push(eyebrow(`${seed}:eyebrow`, kicker));
  blocks.push(heading(`${seed}:heading`, title));
  blocks.push(text(`${seed}:lead`, lead));
  extra.forEach((line, index) => blocks.push(text(`${seed}:extra:${index}`, line)));
  if (cta) blocks.push(button(`${seed}:cta`, cta.label, link(cta.path, { campaign, content: "primary" })));
  if (secondary) blocks.push(button(`${seed}:secondary`, secondary.label, link(secondary.path, { campaign, content: "secondary" }), { preset: "tertiary_button", padding: "0px 32px 20px" }));
  return card(seed, blocks);
}

const COA_LINE = "Every production batch is tested by an independent laboratory and its Certificate of Analysis is filed in a public library you can search by product, batch or lot number.";
const SUPPORT_LINE = `Support answers anything the report does not: <a href="mailto:${SUPPORT_EMAIL}" style="color:${PALETTE.gold};text-decoration:underline;">${SUPPORT_EMAIL}</a>.`;
const FINAL_NOTE = "One more note, then we will leave it with you.";

const cartProducts = (key, campaign) => productSection(`${key}:products`, "product_cart_recovery", { count: 3, buttonText: "View", campaign });
const recommended = (key, campaign, recommender) => productSection(`${key}:products`, "product_recommender", { count: 3, buttonText: "View", campaign, recommender });

/**
 * The quiet card that answers why carts are abandoned (Baymard: unexpected
 * cost, slow delivery, card distrust): dispatch, destinations and tracking,
 * and the encrypted checkout, each the site's canonical sentence verbatim.
 * No free-shipping figure: that threshold is an admin setting and is never
 * baked into a template.
 */
function trustStrip(seed) {
  return card(seed, [
    eyebrow(`${seed}:eyebrow`, "Good to know"),
    text(`${seed}:lines`, [CLAIMS.fulfilment, `${CLAIMS.destinations} ${CLAIMS.tracking}`, "Checkout is encrypted. Card details never touch our servers."], { padding: "0px 32px 20px" }),
  ]);
}

/** The four final-reminder variants an abandonment automation splits into. */
function finalVariants(kind, { kicker, path, label, campaign }) {
  const key = (variant) => `${kind}-3-${variant}`;
  const saved = kind === "cart" ? "Your cart is still saved." : "Your checkout is still saved.";
  return {
    [key("gift-code")]: () => frame(key("gift-code"), [
      hero(`${key("gift-code")}:hero`, {
        kicker, title: FINAL_NOTE,
        lead: `${saved} Two things are attached to it for a short time: a gift added to your order, and a code. Both are described below with their dates.`,
        cta: { label, path }, campaign,
      }),
      spacerSection(`${key("gift-code")}:gap`),
      giftCard(`${key("gift-code")}:gift`),
      spacerSection(`${key("gift-code")}:gap2`),
      codeCard(`${key("gift-code")}:code`, "recovery", campaign, path),
      cartProducts(key("gift-code"), campaign),
    ]),
    [key("gift")]: () => frame(key("gift"), [
      hero(`${key("gift")}:hero`, {
        kicker, title: FINAL_NOTE,
        lead: `${saved} For a short time a gift is attached to it, described below with its date.`,
        cta: { label, path }, campaign,
      }),
      spacerSection(`${key("gift")}:gap`),
      giftCard(`${key("gift")}:gift`),
      cartProducts(key("gift"), campaign),
    ]),
    [key("code")]: () => frame(key("code"), [
      hero(`${key("code")}:hero`, {
        kicker, title: FINAL_NOTE,
        lead: `${saved} If you want to complete it, the code below is valid until the date shown.`,
        cta: { label, path }, campaign,
      }),
      spacerSection(`${key("code")}:gap`),
      codeCard(`${key("code")}:code`, "recovery", campaign, path),
      cartProducts(key("code"), campaign),
    ]),
    [key("plain")]: () => frame(key("plain"), [
      hero(`${key("plain")}:hero`, {
        kicker, title: FINAL_NOTE,
        lead: `${saved} This is the last reminder about it. Batch numbers and reports are on each product page, and support can answer anything the report does not.`,
        cta: { label, path }, campaign,
      }),
      cartProducts(key("plain"), campaign),
    ]),
  };
}

/**
 * The welcome heroes, shared by each email and its coded or code-free twin so
 * the pair differ only by the code card. The store mints the welcome code for
 * site sign-ups at once, for Omnisend form sign-ups on the next nightly
 * reconcile (within a day) and for checkout opt-ins never, and sets
 * vl_welcome_ready to "yes" only once the code exists. So welcome-1, sent at
 * once, never carries the card, and the automation splits the second and
 * third emails on vl-welcome-ready two and five days in.
 */
const WELCOME_HERO = {
  1: {
    kicker: "Welcome", title: "Precision, in every vial.",
    lead: `Vanta Labs Research supplies laboratory research materials. ${COA_LINE}`,
    cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "Read a batch report", path: "/coa-library" },
    showImage: true, campaign: "welcome",
  },
  2: {
    kicker: "Documentation", title: "Anyone can print a label. We publish the proof.",
    lead: "Every lot is tested by a third-party laboratory. The report is filed under its batch number in the COA library, where you can read it before you order and again after it arrives.",
    extra: ["Identity is confirmed by mass spectrometry, so the exact compound and molecular weight of every lot are on the report. The figures live on the certificate, not in this email."],
    cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "Browse the catalogue", path: "/products" },
    campaign: "welcome",
  },
  3: {
    kicker: "Ordering", title: "What happens after you order.",
    lead: CLAIMS.fulfilment,
    extra: [`${CLAIMS.destinations} ${CLAIMS.tracking}`, "Checkout is encrypted. Card details never touch our servers.", "Recon Water and reconstitution accessories are listed under Solvents & Solutions in the catalogue."],
    cta: { label: "Browse the catalogue", path: "/products" },
    campaign: "welcome",
  },
};

export const TEMPLATES = {
  "welcome-1": () => frame("welcome-1", [
    hero("welcome-1:hero", WELCOME_HERO[1]),
    spacerSection("welcome-1:gap"),
    card("welcome-1:catalogue", [
      eyebrow("welcome-1:catalogue:eyebrow", "From the catalogue"),
      text("welcome-1:catalogue:lead", "A few products from the catalogue. Every listing shows its current batch number and links to the report.", { padding: "0px 32px 4px" }),
    ]),
    // Real product photographs and prices, chosen by Omnisend at send time.
    recommended("welcome-1", "welcome", { type: "popular", fallbackType: "newest", isOutOfStockIncluded: false }),
    spacerSection("welcome-1:gap2"),
    trustStrip("welcome-1:trust"),
  ]),

  "welcome-offer": () => frame("welcome-offer", [
    welcomeOfferGiftHero("welcome-offer:hero"),
    spacerSection("welcome-offer:gap"),
    welcomeAlternativeCard("welcome-offer:code"),
    spacerSection("welcome-offer:gap2"),
    trustStrip("welcome-offer:trust"),
  ]),

  "welcome-offer-code": () => frame("welcome-offer-code", [
    hero("welcome-offer-code:hero", {
      kicker: "Your welcome offer", title: "15% off your first order.",
      lead: "Your code is below: one use, tied to this address, on a first order, until the date shown. Every listing in the catalogue shows its current batch number and links to the report.",
      cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "Read a batch report", path: "/coa-library" },
      showImage: true, campaign: "welcome-offer",
    }),
    spacerSection("welcome-offer-code:gap"),
    codeCard("welcome-offer-code:code", "welcome", "welcome-offer"),
    spacerSection("welcome-offer-code:gap2"),
    trustStrip("welcome-offer-code:trust"),
  ]),

  "welcome-2": () => frame("welcome-2", [hero("welcome-2:hero", WELCOME_HERO[2])]),

  "welcome-2-code": () => frame("welcome-2-code", [
    hero("welcome-2-code:hero", WELCOME_HERO[2]),
    spacerSection("welcome-2-code:gap"),
    codeCard("welcome-2-code:code", "welcome", "welcome"),
  ]),

  "welcome-3": () => frame("welcome-3", [
    hero("welcome-3:hero", WELCOME_HERO[3]),
    spacerSection("welcome-3:gap"),
    codeCard("welcome-3:code", "welcome", "welcome"),
  ]),

  "welcome-3-nocode": () => frame("welcome-3-nocode", [hero("welcome-3-nocode:hero", WELCOME_HERO[3])]),

  "cart-1": () => frame("cart-1", [
    hero("cart-1:hero", {
      kicker: "Your cart", title: "Still saved, whenever you are ready.",
      lead: "The items below are held in your cart. Batch numbers and reports are on each product page.",
      cta: { label: "Return to cart", path: "/cart" }, campaign: "abandoned-cart",
    }),
    cartProducts("cart-1", "abandoned-cart"),
    spacerSection("cart-1:gap"),
    trustStrip("cart-1:trust"),
  ]),

  "cart-2": () => frame("cart-2", [
    hero("cart-2:hero", {
      kicker: "Documentation", title: "Before you decide, read the report.",
      lead: COA_LINE,
      extra: ["Your cart is still saved."],
      cta: { label: "Return to cart", path: "/cart" }, secondary: { label: "Open the COA library", path: "/coa-library" }, campaign: "abandoned-cart",
    }),
    cartProducts("cart-2", "abandoned-cart"),
    spacerSection("cart-2:gap"),
    trustStrip("cart-2:trust"),
  ]),

  ...finalVariants("cart", { kicker: "Your cart", path: "/cart", label: "Return to cart", campaign: "abandoned-cart" }),

  "checkout-1": () => frame("checkout-1", [
    hero("checkout-1:hero", {
      kicker: "Your checkout", title: "Finish when you are ready.",
      lead: "Your checkout is saved with the items below. Nothing has been charged.",
      cta: { label: "Return to checkout", path: "/checkout" }, campaign: "abandoned-checkout",
    }),
    cartProducts("checkout-1", "abandoned-checkout"),
    spacerSection("checkout-1:gap"),
    trustStrip("checkout-1:trust"),
  ]),

  "checkout-2": () => frame("checkout-2", [
    hero("checkout-2:hero", {
      kicker: "Your checkout", title: "Still here when you are.",
      lead: "Your checkout is saved and nothing has been charged. The items are below; batch numbers and reports are on each product page.",
      cta: { label: "Return to checkout", path: "/checkout" }, secondary: { label: "Open the COA library", path: "/coa-library" }, campaign: "abandoned-checkout",
    }),
    cartProducts("checkout-2", "abandoned-checkout"),
    spacerSection("checkout-2:gap"),
    trustStrip("checkout-2:trust"),
  ]),

  ...finalVariants("checkout", { kicker: "Your checkout", path: "/checkout", label: "Return to checkout", campaign: "abandoned-checkout" }),

  "browse-1": () => frame("browse-1", [
    hero("browse-1:hero", {
      kicker: "Recently viewed", title: "Still there when you want it.",
      lead: "The products you viewed are below, each with its current batch number and a link to the report on its page.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "browse-abandonment",
    }),
    cartProducts("browse-1", "browse-abandonment"),
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
      kicker: "After your order", title: "Support, reports and reordering.",
      lead: "Three things worth keeping from this email.",
      extra: [
        SUPPORT_LINE,
        "The COA library holds the certificate for every batch we have shipped, searchable by product, batch or lot number, for as long as you need it.",
        "Your order history is in your account. Each product there links back to its listing, which shows the current batch number for a reorder.",
        "A few products chosen from what is ordered alongside yours are below. Every one links to its batch report.",
      ],
      cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "post-purchase",
    }),
    recommended("post-purchase-2", "post-purchase", { type: "popular", fallbackType: "newest", isOutOfStockIncluded: false, purchaseExclusionDays: 30 }),
  ]),

  "replenishment": () => frame("replenishment", [
    hero("replenishment:hero", {
      kicker: "Reorder", title: "When it is time to reorder.",
      lead: "Batches change. The current batch number for each product is on its page, with the report filed under it.",
      cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "replenishment",
    }),
    // `personalized` needs the Pro plan; Omnisend substitutes the fallback silently.
    recommended("replenishment", "replenishment", { type: "personalized", fallbackType: "popular", isOutOfStockIncluded: false }),
  ]),

  "winback-1": () => frame("winback-1", [
    hero("winback-1:hero", {
      kicker: "Since your last order", title: "It has been a while.",
      lead: "The current batch number and report for every product are on its page in the catalogue. Nothing is waiting in your cart; this is a note that the catalogue and the COA library stay open to you.",
      cta: { label: "Browse the catalogue", path: "/products" }, secondary: { label: "Open the COA library", path: "/coa-library" }, campaign: "win-back",
    }),
    recommended("winback-1", "win-back", { type: "popular", fallbackType: "newest", isOutOfStockIncluded: false }),
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

  "winback-2-nocode": () => frame("winback-2-nocode", [
    hero("winback-2-nocode:hero", {
      kicker: "Since your last order", title: "One last note.",
      lead: "This is the last note in this series. The catalogue and the COA library stay open to you whenever you want them, and if you order again the reports for your new batches will be filed the same way.",
      extra: [SUPPORT_LINE],
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "win-back",
    }),
  ]),

  "sunset": () => frame("sunset", [
    hero("sunset:hero", {
      kicker: "Your subscription", title: "Do you want to keep hearing from us?",
      lead: "We send batch reports, restocks and occasional subscriber offers. If you would like to keep receiving them, use the button below. If we do not hear from you, this is the last one.",
      cta: { label: "Keep me on the list", path: "/?stay=1" }, campaign: "sunset",
    }),
    section("sunset:unsub", [footnote("sunset:unsub:text", `Or <a href="[[unsubscribe_link]]" style="color:${PALETTE.muted};text-decoration:underline;">unsubscribe</a> now and we will stop straight away.`, { align: "center" })]),
  ]),

  "new-product": () => frame("new-product", [
    hero("new-product:hero", {
      kicker: "New in the catalogue", title: "A new product is listed.",
      lead: "PRODUCT NAME is now in the catalogue. Replace this line with the listing's own description before sending; state only what the product page and its report state.",
      extra: ["Its first batch has been tested by an independent laboratory and the report is filed in the COA library under its batch number."],
      cta: { label: "View the product", path: "/products" }, secondary: { label: "Read the report", path: "/coa-library" }, campaign: "campaign-new-product",
    }),
    recommended("new-product", "campaign-new-product", { type: "newest", fallbackType: "popular", isOutOfStockIncluded: false }),
  ]),

  "promotion": () => frame("promotion", [
    hero("promotion:hero", {
      kicker: "Subscriber offer", title: "An offer for subscribers.",
      lead: "OFFER DESCRIPTION. Replace this line with the offer exactly as it is set up in the store: what it applies to, the amount and the end date. Nothing here may promise stock, delivery times or results.",
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "campaign-promotion",
    }),
    spacerSection("promotion:gap"),
    section("promotion:code", [
      eyebrow("promotion:code:eyebrow", "Your code"),
      text("promotion:code:code", "CODE", { preset: "mono", padding: "0px 32px 8px" }),
      text("promotion:code:terms", "Replace CODE with the campaign code before sending, and state its terms here in one line: what it applies to, any minimum, and the end date.", { padding: "0px 32px 24px" }),
    ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` }),
  ]),

  "promotion-final-day": () => frame("promotion-final-day", [
    hero("promotion-final-day:hero", {
      kicker: "Subscriber offer", title: "Last day of the offer.",
      lead: "OFFER DESCRIPTION. Replace this line with the offer exactly as it is set up in the store: what it applies to and the amount.",
      extra: ["The offer ends today at 11:59 PM ET."],
      cta: { label: "Browse the catalogue", path: "/products" }, campaign: "campaign-final-day",
    }),
    spacerSection("promotion-final-day:gap"),
    section("promotion-final-day:code", [
      eyebrow("promotion-final-day:code:eyebrow", "Your code"),
      text("promotion-final-day:code:code", "CODE", { preset: "mono", padding: "0px 32px 8px" }),
      text("promotion-final-day:code:terms", "Replace CODE with the campaign code before sending, and state its terms here in one line: what it applies to and any minimum.", { padding: "0px 32px 24px" }),
    ], { background: PALETTE.surfaceRaised, padding: "24px 0px 4px", radius: "16px", border: `1px solid ${PALETTE.goldHairline}` }),
  ]),

  "vip-milestone": () => frame("vip-milestone", [
    hero("vip-milestone:hero", {
      kicker: "Thank you", title: "Thank you for your continued orders.",
      lead: "Our records show [[contact.custom_properties.vl_orders]] orders on this account. Every one of them was tested by an independent laboratory before it shipped, and the reports stay in the COA library for as long as you need them.",
      extra: ["If anything about an order or a report needs a second look, reply to this email and a person will answer."],
      cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "post-purchase",
    }),
  ]),

  "repeat-customer": () => frame("repeat-customer", [
    hero("repeat-customer:hero", {
      kicker: "Thank you", title: "Thank you for ordering again.",
      lead: "A second order is the clearest signal we get that the documentation is doing its job. Every batch you have received has its certificate filed in the COA library under its batch number.",
      extra: [SUPPORT_LINE],
      cta: { label: "Open the COA library", path: "/coa-library" }, secondary: { label: "View your orders", path: "/account/orders" }, campaign: "post-purchase",
    }),
  ]),

  "campaign-batch-report": () => frame("campaign-batch-report", [
    hero("campaign-batch-report:hero", {
      kicker: "Batch report", title: "A new batch report is filed.",
      lead: "PRODUCT NAME — batch BATCH NUMBER, tested DATE by LAB NAME. Replace this line with the values from the published certificate, or delete it; nothing here may be stated that is not on the report.",
      extra: ["The report is filed in the COA library under its batch number."],
      cta: { label: "Read the report", path: "/coa-library" }, secondary: { label: "Browse the catalogue", path: "/products" }, campaign: "campaign",
    }),
    recommended("campaign-batch-report", "campaign", { type: "newest", fallbackType: "popular", isOutOfStockIncluded: false }),
  ]),

  "campaign-restock": () => frame("campaign-restock", [
    hero("campaign-restock:hero", {
      kicker: "Restock", title: "Back in the catalogue.",
      lead: "PRODUCT NAME is back in stock, with a new batch number and its report filed. Replace this line before sending; state stock only as the live store shows it.",
      cta: { label: "View the product", path: "/products" }, secondary: { label: "Read the report", path: "/coa-library" }, campaign: "campaign",
    }),
    recommended("campaign-restock", "campaign", { type: "newest", fallbackType: "popular", isOutOfStockIncluded: false }),
  ]),
};

/**
 * Subject and preview per template. Omnisend's email_content reference
 * documents [[contact.first_name]] but no default or fallback syntax, so every
 * subject is written to need no name. Campaign subjects are starting points
 * the owner edits in the draft.
 */
export const SUBJECTS = {
  "welcome-1": { subject: "Welcome to Vanta Labs", preview: "What we supply, and how every batch is documented." },
  "welcome-offer": { subject: "Your welcome offer: a free GHK-Cu, or 15% off", preview: "Choose either on a first order. Dates and terms inside." },
  "welcome-offer-code": { subject: "Your welcome code: 15% off a first order", preview: "One use, tied to this address. Valid until the date inside." },
  "welcome-2": { subject: "Every batch has a published report", preview: "Search a lot number and read the certificate itself." },
  "welcome-2-code": { subject: "Every batch has a published report", preview: "Read the certificate itself. Your welcome code is inside." },
  "welcome-3": { subject: "How ordering works", preview: "Dispatch by 2PM ET on business days, tracking after dispatch." },
  "welcome-3-nocode": { subject: "How ordering works", preview: "Dispatch by 2PM ET on business days, tracking after dispatch." },
  "cart-1": { subject: "Your cart is saved", preview: "Everything is still in it, with batch reports on each product page." },
  "cart-2": { subject: "Before you decide, read the report", preview: "Your cart is still saved. The certificate for each batch is a click away." },
  "cart-3-gift-code": { subject: "A gift and a code for your saved cart", preview: "Both are attached for a short time. Dates inside." },
  "cart-3-gift": { subject: "A gift for your saved cart", preview: "Attached for a short time. The date is inside." },
  "cart-3-code": { subject: "A code for your saved cart", preview: "Valid until the date inside." },
  "cart-3-plain": { subject: "One more note about your cart", preview: "This is the last reminder. Your cart is still saved." },
  "checkout-1": { subject: "Finish when you are ready", preview: "Your checkout is saved. Nothing has been charged." },
  "checkout-2": { subject: "Still here when you are", preview: "Dispatch by 2PM ET on business days, tracking after dispatch." },
  "checkout-3-gift-code": { subject: "A gift and a code for your saved checkout", preview: "Both are attached for a short time. Dates inside." },
  "checkout-3-gift": { subject: "A gift for your saved checkout", preview: "Attached for a short time. The date is inside." },
  "checkout-3-code": { subject: "A code for your saved checkout", preview: "Valid until the date inside." },
  "checkout-3-plain": { subject: "One more note about your checkout", preview: "This is the last reminder. Nothing has been charged." },
  "browse-1": { subject: "You were looking at this", preview: "The batch report is on the product page." },
  "post-purchase-1": { subject: "Your batch report", preview: "How to find the certificate for what you ordered." },
  "post-purchase-2": { subject: "Support, reports and reordering", preview: "Three things worth keeping after an order." },
  "replenishment": { subject: "When it is time to reorder", preview: "Batches change. The current batch number is on each product page." },
  "winback-1": { subject: "It has been a while", preview: "The current batch report for every product is on its page." },
  "winback-2": { subject: "One last note from us", preview: "Your code is valid until the date inside." },
  "winback-2-nocode": { subject: "One last note from us", preview: "The catalogue and the COA library stay open to you." },
  "sunset": { subject: "Do you want to keep hearing from us?", preview: "One click keeps you on the list." },
  "new-product": { subject: "New in the catalogue", preview: "Listed with its first batch report filed." },
  "promotion": { subject: "An offer for subscribers", preview: "The code and its terms are inside." },
  "promotion-final-day": { subject: "Last day of the subscriber offer", preview: "The offer ends today at 11:59 PM ET." },
  "vip-milestone": { subject: "Thank you for your continued orders", preview: "Every report stays in the COA library for as long as you need it." },
  "repeat-customer": { subject: "Thank you for ordering again", preview: "Every batch you have received has its certificate filed." },
  "campaign-batch-report": { subject: "A new batch report is filed", preview: "Read the certificate in the COA library." },
  "campaign-restock": { subject: "Back in the catalogue", preview: "Restocked with a new batch number and its report filed." },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
export { hexId };
