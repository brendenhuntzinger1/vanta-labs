// Omnisend asset generator for Vanta Labs — the brand template system as data.
//
// Every layout, template, automation, segment and form in the Omnisend account
// is produced from these files, so the account can be rebuilt or diffed rather
// than hand-edited. `node scripts/omnisend/render.mjs <asset>` prints the exact
// JSON body that was (or should be) sent to Omnisend's API.
//
// Palette and type come from references/brand.md and src/app/globals.css: the
// site's champagne gold, rationed; charcoal surfaces; Fraunces display with a
// Georgia fallback; Manrope body with a Helvetica fallback. Emails cannot load
// the site's stylesheet, so the values are baked in here on purpose.

import { createHash } from "node:crypto";

export const SITE = "https://www.vantalabsresearch.com";
export const SUPPORT_EMAIL = "support@vantalabsresearch.com";

export const PALETTE = {
  background: "#0a0a0a",
  surface: "#141414",
  surfaceRaised: "#1a1a1a",
  foreground: "#ffffff",
  body: "#d4d4d4",
  muted: "#a3a3a3",
  subtle: "#8a8a8a",
  gold: "#c7ae5e",
  goldHover: "#d8c07a",
  hairline: "rgba(255,255,255,0.08)",
  hairlineStrong: "rgba(255,255,255,0.16)",
  goldHairline: "rgba(199,174,94,0.55)",
  buttonText: "#f6f4ef",
};

export const FONTS = {
  display: "Fraunces, Georgia, 'Times New Roman', serif",
  body: "Manrope, Helvetica, Arial, sans-serif",
  mono: "'Geist Mono', SFMono-Regular, Menlo, monospace",
};

/**
 * Uploaded through the Images API on 2026-09-15; ids are stable per account.
 * `hero` is the site's own product vial (GHK-Cu on a dark field, the home-page
 * poster, 960x960, 37 KB): a real Vanta Labs product, at the owner's request,
 * never a generic or generated vial. A generated vial uploaded on 2026-09-16
 * (6aab0150b313445127d3c61c) is unused and can be deleted from the library.
 */
export const IMAGES = {
  logo: { id: "6aa9857db313445127d393bd", url: "https://app.omnisend.com/images/6aa9857db313445127d393be", width: 1024, height: 1024 },
  hero: { id: "6aa98560b313445127d393b8", url: "https://app.omnisend.com/images/6aa98560b313445127d393b9", width: 960, height: 960 },
  og: { id: "6aa9857eb313445127d393bf", url: "https://app.omnisend.com/images/6aa9857eb313445127d393c1", width: 2000, height: 1050 },
};

/** Canonical sentences from src/lib/trust-claims.ts, verbatim. */
export const CLAIMS = {
  researchUse: "For laboratory research use only. Not for human or veterinary use.",
  fulfilment: "In-stock orders placed before 2PM ET on a business day are dispatched the same day. Carrier transit time is additional.",
  destinations: "Ships to the United States and Canada.",
  tracking: "Tracking is emailed after dispatch.",
};

/**
 * Deterministic 24-hex ids: the same asset always produces the same ids, so a
 * re-render diffs cleanly against what the account holds.
 */
export function hexId(seed) {
  return createHash("sha256").update(String(seed)).digest("hex").slice(0, 24);
}

/** A link that carries the recipient's grant through the account wall (spec §3.3). */
export function link(path, { campaign, medium = "email", content } = {}) {
  const params = new URLSearchParams({ to: path, utm_source: "omnisend", utm_medium: medium, utm_campaign: campaign ?? "omnisend" });
  if (content) params.set("utm_content", content);
  // The personalisation tag must survive untouched, so it is appended raw. The
  // address is sealed inside vl_link (link-token.ts v2); it never rides in the URL.
  return `${SITE}/api/email/omnisend-link?t=[[contact.custom_properties.vl_link]]&${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Style presets. The five text presets and three button presets are required
// by Omnisend whenever presets are supplied; `eyebrow` and `mono` are ours.
// ---------------------------------------------------------------------------

export function textPresets() {
  return [
    { id: "heading_large", name: "Heading Large", styles: { fontFamily: FONTS.display, fontSize: "34px", color: PALETTE.foreground, lineHeight: "120%", letterSpacing: "0px" } },
    { id: "heading_medium", name: "Heading Medium", styles: { fontFamily: FONTS.display, fontSize: "26px", color: PALETTE.foreground, lineHeight: "125%", letterSpacing: "0px" } },
    { id: "heading_small", name: "Heading Small", styles: { fontFamily: FONTS.display, fontSize: "20px", color: PALETTE.foreground, lineHeight: "130%", letterSpacing: "0px" } },
    { id: "paragraph", name: "Paragraph", styles: { fontFamily: FONTS.body, fontSize: "16px", color: PALETTE.body, lineHeight: "160%", letterSpacing: "0px" } },
    { id: "footnote", name: "Footnote", styles: { fontFamily: FONTS.body, fontSize: "12px", color: PALETTE.subtle, lineHeight: "150%", letterSpacing: "0px" } },
    { id: "eyebrow", name: "Eyebrow", styles: { fontFamily: FONTS.body, fontSize: "11px", color: PALETTE.gold, lineHeight: "150%", letterSpacing: "3px" } },
    { id: "mono", name: "Mono", styles: { fontFamily: FONTS.mono, fontSize: "13px", color: PALETTE.foreground, lineHeight: "150%", letterSpacing: "1px" } },
  ];
}

export function buttonPresets() {
  const base = { fontFamily: FONTS.body, fontSize: "13px", fontWeight: "bold", letterSpacing: "1px", paddingLeft: "24px", paddingRight: "24px", paddingTop: "14px", paddingBottom: "14px", borderRadius: "14px" };
  return [
    // The site's primary (.vl-btn-primary): ivory fill, near-black label, pill. One per
    // email, so the single action is the focal point; never a gold fill (brand.md).
    { id: "primary_button", name: "Primary", styles: { ...base, backgroundColor: PALETTE.buttonText, border: "1px solid rgba(255,255,255,0.84)", color: "#111111", borderRadius: "999px" } },
    { id: "secondary_button", name: "Secondary", styles: { ...base, backgroundColor: "transparent", border: `1px solid ${PALETTE.hairlineStrong}`, color: PALETTE.foreground } },
    { id: "tertiary_button", name: "Tertiary", styles: { ...base, backgroundColor: "transparent", border: "0px solid transparent", color: PALETTE.gold, textDecoration: "underline", paddingLeft: "0px", paddingRight: "0px" } },
  ];
}

export function generalSettings() {
  return {
    content: { backgroundColor: PALETTE.background, width: "600px", fontFamily: FONTS.body, fontSize: "16px", color: PALETTE.foreground },
    body: { backgroundColor: PALETTE.background },
    buttonPresets: buttonPresets(),
    textPresets: textPresets(),
    logo: { link: link("/", { campaign: "header" }), resizeWidth: 56 },
  };
}

// ---------------------------------------------------------------------------
// Block DSL. Each helper takes a seed for its id so ids are stable.
// ---------------------------------------------------------------------------

const p = (html, align = "left") => `<p style="margin:0;text-align:${align};">${html}</p>`;

export function text(seed, html, { preset = "paragraph", align = "left", padding = "0px 32px 12px" } = {}) {
  const lines = Array.isArray(html) ? html : [html];
  return { id: hexId(seed), type: "text", text: lines.map((line) => p(line, align)).join(""), stylePresetID: preset, styleProperties: { padding, alignment: align } };
}

export function eyebrow(seed, label, opts = {}) {
  return text(seed, label.toUpperCase(), { preset: "eyebrow", padding: "0px 32px 10px", ...opts });
}

export function heading(seed, html, opts = {}) {
  return text(seed, html, { preset: "heading_medium", padding: "0px 32px 14px", ...opts });
}

export function footnote(seed, html, opts = {}) {
  return text(seed, html, { preset: "footnote", padding: "0px 32px 8px", ...opts });
}

export function button(seed, label, href, { preset = "primary_button", align = "left", padding = "8px 32px 24px", fullWidth = false } = {}) {
  return { id: hexId(seed), type: "button", button: { text: label.toUpperCase(), link: href, isFullWidth: fullWidth }, stylePresetID: preset, styleProperties: { padding, alignment: align } };
}

export function image(seed, img, { link: href, alt = "", width = 536, padding = "0px 32px 20px", align = "center" } = {}) {
  return { id: hexId(seed), type: "image", image: { source: img.url, altText: alt, link: href, resizeWidth: width, width: img.width, height: img.height, isExternalSource: false }, styleProperties: { padding, alignment: align } };
}

export function spacer(seed, height = 16) {
  return { id: hexId(seed), type: "lineSpace", lineSpace: { height, type: "space" }, styleProperties: { padding: "0px" } };
}

export function rule(seed) {
  return { id: hexId(seed), type: "lineSpace", lineSpace: { height: 1, type: "line" }, styleProperties: { padding: "8px 32px", dividerColor: PALETTE.hairline } };
}

export function column(seed, blocks, width = "600px") {
  return { id: hexId(seed), width, blocks };
}

export function row(seed, columns) {
  return { id: hexId(seed), columns };
}

/** A plain section: one row, one column, the blocks in order. */
export function section(seed, blocks, { background = PALETTE.background, padding = "0px", radius = "0px", border } = {}) {
  const styleProperties = { backgroundColor: background, padding, borderRadius: radius };
  if (border) styleProperties.border = border;
  return { id: hexId(`${seed}:section`), type: "", styleProperties, rows: [row(`${seed}:row`, [column(`${seed}:col`, blocks)])] };
}

/** A card: the site's dark-glass panel. */
export function card(seed, blocks) {
  return section(seed, blocks, { background: PALETTE.surface, padding: "28px 0px 8px", radius: "16px", border: `1px solid ${PALETTE.hairline}` });
}

/** A section that references a universal layout (header or footer). */
export function layoutRef(seed, universalLayoutID) {
  // The API requires at least one row even though a reference's own content
  // is ignored at read time; a single empty spacer satisfies the validator.
  return {
    id: hexId(`${seed}:layout`),
    type: "universal_layout",
    settings: { universalLayoutID },
    styleProperties: {},
    rows: [row(`${seed}:layout:row`, [column(`${seed}:layout:col`, [spacer(`${seed}:layout:space`, 1)])])],
  };
}

/**
 * A dynamic product section. Omnisend fills each `product` block with a real
 * product per recipient at send time; the fields here are the slot layout.
 */
export function productSection(seed, type, { count = 3, recommender, buttonText = "View", campaign } = {}) {
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const slot = `${seed}:product:${index}`;
    const href = link("/products", { campaign });
    const label = buttonText.toUpperCase();
    blocks.push({
      id: hexId(slot),
      type: "product",
      product: { title: "Product", price: "$0.00", buttonText: label, link: href },
      // Omnisend renders a product block through role-tagged components and
      // rejects a block without them ("block must have at least 1 component").
      // Each mirrors the placeholder above; the platform fills them per
      // recipient at send time.
      components: [
        { id: hexId(`${slot}:image`), type: "image", role: "product_image", image: { link: href, altText: "Product" }, styleProperties: { padding: "0px 0px 12px", alignment: "center" } },
        { id: hexId(`${slot}:title`), type: "text", role: "product_title", text: p("Product", "center"), stylePresetID: "heading_small", styleProperties: { padding: "0px 0px 6px", alignment: "center" } },
        {
          id: hexId(`${slot}:prices`), type: "price", role: "product_prices", styleProperties: { padding: "0px 0px 12px", alignment: "center" },
          components: [
            { id: hexId(`${slot}:price:current`), type: "text", role: "product_current_price", text: p("$0.00", "center"), stylePresetID: "paragraph", styleProperties: { alignment: "center", color: PALETTE.gold } },
            { id: hexId(`${slot}:price:old`), type: "text", role: "product_old_price", text: p("$0.00", "center"), stylePresetID: "footnote", styleProperties: { alignment: "center", color: PALETTE.muted } },
          ],
        },
        { id: hexId(`${slot}:button`), type: "button", role: "product_button", button: { text: label, link: href, isFullWidth: false }, stylePresetID: "secondary_button", styleProperties: { padding: "0px", alignment: "center" } },
      ],
      // Outlined, so the email's one primary button stays the focal point; the
      // image runs to the tile's edges the way the site's product card shows it.
      stylePresetID: "secondary_button",
      styleProperties: { padding: "0px 0px 16px", backgroundColor: PALETTE.surface, borderRadius: "16px", color: PALETTE.foreground, priceColor: PALETTE.gold, secondaryColor: PALETTE.muted, fontFamily: FONTS.body },
    });
  }
  const out = {
    id: hexId(`${seed}:section`),
    type,
    settings: { isOutOfStockHidden: true, isProductImagesFitted: true },
    styleProperties: { backgroundColor: PALETTE.background, padding: "8px 16px 16px" },
    rows: [row(`${seed}:row`, blocks.map((block, index) => column(`${seed}:col:${index}`, [block], `${Math.floor(600 / count)}px`)))],
  };
  if (recommender) out.productRecommender = recommender;
  return out;
}

export function template(name, sections) {
  return { name, generalSettings: generalSettings(), sections };
}
