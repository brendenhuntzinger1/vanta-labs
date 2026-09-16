import { CLAIMS, IMAGES, PALETTE, SUPPORT_EMAIL, footnote, hexId, image, link, row, column, text, eyebrow } from "./lib.mjs";

/**
 * Universal header: the monogram, linked home through the grant route, and a
 * one-line eyebrow. Deliberately quiet — the brand's header is a wordmark on
 * black, not a banner.
 */
export function header() {
  return {
    name: "VL Header",
    content: {
      id: hexId("layout:header"),
      styleProperties: { backgroundColor: PALETTE.background, padding: "28px 0px 8px" },
      rows: [row("layout:header:row", [column("layout:header:col", [
        image("layout:header:logo", IMAGES.logo, { link: link("/", { campaign: "header" }), alt: "Vanta Labs", width: 56, padding: "0px 32px 12px" }),
        eyebrow("layout:header:eyebrow", "Vanta Labs · Research materials", { align: "center", padding: "0px 32px 4px" }),
      ])])],
    },
  };
}

/**
 * Universal footer: the research-use sentence, support, the postal address,
 * the unsubscribe link and the two verified social profiles. CAN-SPAM needs
 * the address on every commercial message; it is set in ONE place so the owner
 * fills it in once.
 */
export function footer() {
  const links = `<a href="${link("/coa-library", { campaign: "footer" })}" style="color:${PALETTE.muted};text-decoration:underline;">COA library</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${link("/products", { campaign: "footer" })}" style="color:${PALETTE.muted};text-decoration:underline;">Catalogue</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${link("/account", { campaign: "footer" })}" style="color:${PALETTE.muted};text-decoration:underline;">Account</a>`;
  const social = `<a href="https://www.instagram.com/vantalabsresearch/" style="color:${PALETTE.muted};text-decoration:underline;">Instagram</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://www.tiktok.com/@officialvantalabs" style="color:${PALETTE.muted};text-decoration:underline;">TikTok</a>`;
  return {
    name: "VL Footer",
    content: {
      id: hexId("layout:footer"),
      styleProperties: { backgroundColor: PALETTE.background, padding: "24px 0px 32px", border: `1px solid ${PALETTE.hairline}`, borderRadius: "0px" },
      rows: [row("layout:footer:row", [column("layout:footer:col", [
        text("layout:footer:links", links, { preset: "footnote", align: "center", padding: "0px 32px 14px" }),
        footnote("layout:footer:research", CLAIMS.researchUse, { align: "center" }),
        footnote("layout:footer:support", `Vanta Labs Research · Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:${PALETTE.muted};text-decoration:underline;">${SUPPORT_EMAIL}</a>`, { align: "center" }),
        footnote("layout:footer:address", "[[account.name]] · POSTAL ADDRESS — owner to replace before the first send", { align: "center" }),
        footnote("layout:footer:social", social, { align: "center" }),
        footnote("layout:footer:unsub", `You are receiving this because you subscribed at vantalabsresearch.com. <a href="[[unsubscribe_link]]" style="color:${PALETTE.muted};text-decoration:underline;">Unsubscribe</a>`, { align: "center", padding: "6px 32px 0px" }),
      ])])],
    },
  };
}
