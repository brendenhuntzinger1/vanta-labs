import { escapeHtml, renderLayout, toText } from "@/lib/email/templates";
import { isSafeSitePath } from "@/lib/email/cta-path";
import { renderAffiliateMergeFields, type AffiliateMergeContext } from "@/lib/email/affiliate-merge";
import type { EmailTemplate } from "@/lib/email/types";

/**
 * The affiliate broadcast template.
 *
 * BUILT ON THE EXISTING LAYOUT, NOT BESIDE IT. `renderLayout` is what gives
 * every Vanta Labs email its shell — the branding, the dark card, the preheader,
 * the single pill button. This template reuses it verbatim so an affiliate
 * broadcast looks like every other message from this store, and so a change to
 * the house style reaches affiliate mail for free. The only thing added is a
 * stack of resource buttons, which `campaignTemplate` has no need for.
 *
 * `campaignTemplate` is deliberately left alone. Customer campaigns render
 * exactly as they did.
 *
 * THE OWNER WRITES THE MESSAGE. Nothing here adds a discount, a deadline, an
 * incentive or a claim about a product. The only text this module contributes is
 * the word on a button the owner typed and the postal address the law requires.
 */

/** More than a handful of buttons stops being a message and starts being a link farm. */
export const MAX_LINK_BUTTONS = 6;

export type LinkButton = { label: string; url: string };

/**
 * Can this link be click-tracked?
 *
 * Only a plain, same-origin path can. Two exclusions, both load-bearing:
 *
 *   * AN OFF-SITE URL IS NEVER TRACKED. The click redirect resolves its
 *     destination from the campaign row and normalises it to this origin, which
 *     is what stops it being an open redirect on a domain affiliates have been
 *     trained to click. Letting a stored destination point off-site would hand
 *     that property away for a click statistic.
 *   * A PERSONALISED URL IS NEVER TRACKED. `{{referral_link}}` resolves to a
 *     different destination for every recipient, and the click route has only
 *     the campaign row to work from — it cannot know whose link it is. So a
 *     personalised button is merged and linked directly, which is also the only
 *     way it can be correct.
 *
 * Both cases still work perfectly as links. They are simply not counted.
 */
export function isTrackableLink(url: string, siteUrl: string): boolean {
  const value = String(url ?? "").trim();
  if (!value) return false;
  // A merge variable makes the destination per-recipient; see above.
  if (value.includes("{{")) return false;
  // Resolution-based, not prefix-based — `/\evil.com` passes a naive
  // "starts with /" test and resolves to another host. See cta-path.ts.
  return isSafeSitePath(value, siteUrl);
}

/**
 * Clean the button list on the way INTO the database.
 *
 * Junk is dropped rather than rejected, so one empty row left behind in the
 * composer does not block a send — but a `javascript:` url is refused outright
 * rather than trimmed into something harmless-looking.
 */
export function normalizeLinkButtons(value: unknown): LinkButton[] {
  if (!Array.isArray(value)) return [];
  const buttons: LinkButton[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const label = String((entry as LinkButton).label ?? "").trim().slice(0, 60);
    const url = String((entry as LinkButton).url ?? "").trim().slice(0, 500);
    if (!label || !url) continue;
    // Scheme allow-list rather than a deny-list: anything that is not an http(s)
    // URL, a site path, or a merge variable that will become one has no business
    // in a button.
    const lowered = url.toLowerCase();
    const looksSafe = lowered.startsWith("http://") || lowered.startsWith("https://") || url.startsWith("/") || url.includes("{{");
    if (!looksSafe) continue;
    buttons.push({ label, url });
    if (buttons.length >= MAX_LINK_BUTTONS) break;
  }
  return buttons;
}

function renderButtonRow(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;background:transparent;color:#f2c94c;border:1px solid rgba(242,201,76,0.5);text-decoration:none;font-weight:600;font-size:13px;padding:10px 18px;border-radius:999px;">${escapeHtml(label)}</a>`;
}

/**
 * Render one affiliate's copy of a campaign.
 *
 * `trackedUrlFor` is injected rather than imported so that link-tracking policy
 * can be asserted without a signing secret, and so this module never needs to
 * know how a tracking link is signed.
 */
export function buildAffiliateCampaignEmail(input: {
  subject: string;
  previewText: string | null;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaPath: string;
  linkButtons: LinkButton[];
  mergeContext: AffiliateMergeContext;
  siteUrl: string;
  postalAddress: string;
  /** `null` is the primary CTA; a number is that button's index. */
  trackedUrlFor: (linkIndex: number | null) => string;
}): EmailTemplate {
  const merge = (value: string) => renderAffiliateMergeFields(String(value ?? ""), input.mergeContext);
  const origin = String(input.siteUrl ?? "").replace(/\/$/, "");

  const subject = merge(input.subject);
  const headline = merge(input.headline);
  const bodyText = merge(input.body);
  const postalAddress = String(input.postalAddress ?? "");

  // Same paragraph handling campaignTemplate uses, so a message typed in either
  // composer breaks identically: blank line starts a paragraph, single newline
  // becomes a line break, everything is escaped.
  const paragraphs = bodyText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  // Resolve each extra button to the URL that actually goes in the email.
  const resolvedButtons = input.linkButtons.map((button, index) => {
    const trackable = isTrackableLink(button.url, origin);
    const merged = merge(button.url);
    return {
      label: merge(button.label),
      // Tracked links go through the redirect; everything else is linked
      // directly at its merged destination.
      href: trackable ? input.trackedUrlFor(index) : merged,
      destination: trackable ? `${origin}${merged.startsWith("/") ? merged : `/${merged}`}` : merged,
    };
  });

  const buttonsHtml = resolvedButtons.length > 0
    ? `<div class="resource-buttons" style="margin:20px 0 4px;">${resolvedButtons.map((b) => renderButtonRow(b.label, b.href)).join("")}</div>`
    : "";

  const ctaLabel = merge(input.ctaLabel);
  const ctaTrackable = isTrackableLink(input.ctaPath, origin);
  const ctaUrl = ctaTrackable ? input.trackedUrlFor(null) : merge(input.ctaPath);

  const footerNoteHtml = `<p style="margin:12px 0 0;font-size:11px;color:#71717a;">${escapeHtml(postalAddress).replace(/\n/g, "<br/>")}</p>`;

  const html = renderLayout({
    preheader: input.previewText?.trim() ? merge(input.previewText) : headline,
    titleHtml: escapeHtml(headline),
    bodyHtml: `${paragraphs}${buttonsHtml}`,
    ctaLabel,
    ctaUrl,
    footerNoteHtml,
  });

  const text = toText([
    headline,
    "",
    bodyText.trim(),
    "",
    `${ctaLabel}: ${ctaUrl}`,
    ...(resolvedButtons.length > 0 ? [""] : []),
    // The plain-text part names every destination. A text-only client that
    // renders no buttons must still be able to reach the resources.
    ...resolvedButtons.map((b) => `${b.label}: ${b.href}`),
    "",
    postalAddress,
  ]);

  return { subject, html, text };
}
