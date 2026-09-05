import type { EmailTemplate } from "@/lib/email/types";
import { formatDisplayDate } from "@/lib/format-date";
import { DEFAULT_CARD_PROCESSING_FEE } from "@/lib/payment-methods";
import { DEFAULT_COMMISSION_HOLD_DAYS } from "@/lib/referral-config";
import {
  DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
  DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
} from "@/lib/admin-control-shared";

// ONE CHARGE, ONE NAME. The receipt used to call the card surcharge "Card
// processing fee" while the checkout screen called it "Service Fee" and the
// confirmation page called it "Shipping protection" — three names for one line,
// on three screens the same customer sees within a minute of paying. This is
// the same label the checkout screen, the invoice and Admin → Payments use.
const CARD_FEE_LABEL = DEFAULT_CARD_PROCESSING_FEE.label;

// Exported so the marketing wrapper escapes the CAN-SPAM postal address exactly
// the way campaignTemplate does — the two must agree, or the "is the address
// already in this HTML?" check silently stops matching and mail goes out with
// the address twice.
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

// `titleHtml` and `bodyHtml` are ALREADY-ESCAPED HTML supplied by the caller;
// `preheader`, `ctaLabel` and `ctaUrl` are raw text escaped here.
//
// The title used to be escaped here too, but every caller escapes the customer
// name before interpolating it — so it was escaped twice, and anyone whose name
// or product contained an ampersand read "Ben &amp; Jerry" in the heading of
// their receipt. Naming it `titleHtml` states the contract the way `bodyHtml`
// already did, instead of leaving two plausible readings of `title`.
// `footerNoteHtml` is already-escaped HTML appended inside the footer cell. It
// exists for the CAN-SPAM postal address that commercial mail must carry and
// transactional mail must not be forced to invent; anything else that belongs
// below the rule can use it too.
/**
 * Brand palette for email. Kept here rather than imported from the web theme
 * because an email cannot load a stylesheet: every colour has to be a literal
 * in the markup, and the two surfaces drift on purpose (the site's gold is a
 * CSS variable that can be themed; this one is baked into messages already
 * sitting in people's inboxes and can never be restyled after the fact).
 */
const VANTA_GOLD = "#F2C94C";
const CARD_INK = "#111111";
const NEUTRAL_SURFACE = "#F4F4F4";

/**
 * Which job a button is doing, because "click here" is not one job.
 *
 *   primary  → the commercial ask. Shop, reorder, claim, restore a cart. Gold,
 *              because it should be the loudest thing in the message.
 *   utility  → the functional ask. Confirm an address, reset a password, open a
 *              dashboard, track a parcel. Neutral, because dressing a password
 *              reset up as a sales button is how a transactional message starts
 *              looking like marketing to a filter — and to a reader.
 *
 * Utility is the DEFAULT deliberately. A template that says nothing gets the
 * restrained treatment; selling is opt-in. The reverse default would quietly
 * turn every receipt gold the moment someone added a button to it.
 */
export type EmailCtaVariant = "primary" | "utility";

const CTA_PALETTE: Record<EmailCtaVariant, { background: string; text: string }> = {
  primary: { background: VANTA_GOLD, text: CARD_INK },
  utility: { background: NEUTRAL_SURFACE, text: CARD_INK },
};

/**
 * True when a CTA destination is safe to put in an anchor.
 *
 * The CTA path validator in cta-path.ts guards what an OPERATOR may store; this
 * guards what may be RENDERED, and they are not the same question. By the time
 * a URL reaches here it may have come from a database row written before those
 * checks existed, from a template's own hard-coded string, or from a caller
 * that built it by concatenation. `javascript:` and `data:` in an href are
 * inert in every mail client worth naming, but they are not inert in a browser
 * preview, in a webmail client that renders the message in-page, or in the
 * admin preview iframe this repo now serves — so they are refused here rather
 * than assumed harmless.
 */
function isRenderableCtaUrl(url: string): boolean {
  if (/[\x00-\x1F\x7F]/.test(url)) return false;
  return /^(https?:\/\/|mailto:|\/)/i.test(url);
}

/**
 * The one button markup every Vanta email uses.
 *
 * WHY THIS IS A TABLE AND NOT THE ONE-LINE ANCHOR IT REPLACED.
 *
 * The previous button was `<a style="display:inline-block;padding:12px 24px;
 * background:#f4f4f4;…">`. That is correct CSS and it renders correctly in
 * Gmail, Apple Mail and every webmail client — and it falls apart in Outlook on
 * Windows, which renders mail through Word's layout engine. Word supports
 * neither `display:inline-block` nor padding on an inline element, so the
 * padding box collapses and the "button" degrades to a run of text with a
 * background colour behind the glyphs. It still worked; it stopped looking like
 * a button in the one client where looking like a button matters most, because
 * Outlook's audience skews to exactly the desktop buyers who convert.
 *
 * The fix is the standard bulletproof shape, and each piece earns its place:
 *
 *   `<td bgcolor>`        Word honours a table cell's background attribute. This
 *                         is what actually fills the button in Outlook.
 *   `mso-padding-alt`     Word-only padding. Outlook reads it and gets a real
 *                         padded cell; every other client ignores the property
 *                         entirely, so it cannot double up with the anchor's
 *                         own padding below.
 *   anchor padding        What every non-Outlook client uses. Kept on the <a>
 *                         rather than the <td> so the whole pill stays
 *                         clickable, not just the glyphs.
 *   `border-radius:999px` On the anchor. Word ignores it, so Outlook shows a
 *                         square button — the one accepted degradation. It is
 *                         also load-bearing for template-standards.test.ts,
 *                         which uses it to tell a real CTA from a naked anchor.
 *
 * A VML `roundrect` would buy back the rounded corner and the full click target
 * in Outlook, and it is deliberately not used: VML needs a fixed pixel width,
 * which means guessing the rendered width of operator-typed label text. A label
 * one character too long for the guess overflows its own button. A square
 * button that always fits beats a round one that sometimes does not.
 *
 * `mso-line-height-rule:exactly` stops Word inflating the line box and turning
 * a 52px button into a 60px one.
 *
 * RETURNS EMPTY STRING when there is nothing to render — see renderLayout.
 */
export function renderCtaButton(input: {
  label: string;
  url: string;
  variant?: EmailCtaVariant;
}): string {
  const label = String(input.label ?? "").trim();
  const url = String(input.url ?? "").trim();
  if (!label || !url || !isRenderableCtaUrl(url)) return "";

  const { background, text } = CTA_PALETTE[input.variant ?? "utility"];

  // THE NUMBERS ARE MEASURED, NOT CHOSEN.
  //
  // 16px of vertical padding around a 20px line box is a 52px target, clear of
  // the 44px minimum Apple and Google both publish for touch. The old button
  // was 12px around a 13px line — about 37px, small enough on a phone that a
  // near-miss scrolls the message instead of opening the store.
  //
  // The horizontal padding and tracking were tightened from 36px/0.08em after
  // rendering every real label at 390px in Chromium: "CLAIM YOUR FREE GHK-CU"
  // wrapped to two lines and broke mid-word as "GHK-/CU", which reads as a
  // broken template rather than a long label. At 28px/0.05em every label an
  // operator is likely to type — up to "BROWSE THE CATALOG" and beyond — sits
  // on one line, and the button is still 52px tall.
  //
  // `word-break` is the one that stops a real defect rather than a cosmetic
  // one. The admin caps a label at 40 characters, and 40 characters with no
  // space in them is a single unbreakable word: without this the anchor grew to
  // 553px inside a 390px viewport and the whole EMAIL scrolled sideways.
  // `max-width` is in pixels, not a percentage, because
  // affiliate-campaign-template.test.ts forbids "%" below the brand paragraph
  // — 456px is the card's 520px inner width less its two 32px insets.
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;border-collapse:separate;">`
    + `<tr><td align="center" bgcolor="${background}" style="border-radius:999px;mso-padding-alt:16px 28px;">`
    + `<a href="${escapeHtml(url)}" style="display:inline-block;padding:16px 28px;`
    + `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;`
    + `font-size:15px;line-height:20px;mso-line-height-rule:exactly;font-weight:700;`
    + `letter-spacing:0.05em;text-transform:uppercase;color:${text};`
    + `text-decoration:none;border-radius:999px;max-width:456px;word-break:break-word;">${escapeHtml(label)}</a>`
    + `</td></tr></table>`;
}

export function renderLayout(input: { preheader: string; titleHtml: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string; ctaVariant?: EmailCtaVariant; footerNoteHtml?: string }) {
  // Blank is a legitimate answer, not a bug. An operator who clears the button
  // text or the destination on an automation means "no button on this one", and
  // the message must then render as a clean piece of copy — not as an empty
  // pill, and not as a button pointing at nowhere. renderCtaButton returns ""
  // for every unusable combination, so the row simply does not exist.
  const button = renderCtaButton({
    label: input.ctaLabel ?? "",
    url: input.ctaUrl ?? "",
    variant: input.ctaVariant,
  });
  // The cell keeps the card's 32px inset even though the button is centred
  // inside it: the inset is what stops the pill touching the card edge on a
  // narrow phone, and layout-alignment.test.ts holds every card row to it.
  const cta = button ? `<tr><td align="center" style="padding:28px 32px 4px;">${button}</td></tr>` : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Vanta Labs</title></head>
<body style="margin:0;padding:0;background:#050505;color:#f4f4f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(input.preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#111111;border:1px solid rgba(255,255,255,0.12);border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 32px 0;">
          <p style="margin:0;font-size:13px;letter-spacing:0.32em;text-transform:uppercase;color:#f2c94c;font-weight:700;">Vanta Labs</p>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;">
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#ffffff;">${input.titleHtml}</h1>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;font-size:14px;line-height:1.7;color:#d4d4d4;">
          ${input.bodyHtml}
        </td></tr>
        ${cta}
        <tr><td style="padding:28px 32px 24px;border-top:1px solid rgba(255,255,255,0.1);margin-top:24px;">
          <p style="margin:20px 0 0;font-size:12px;color:#71717a;">Vanta Labs · Research Use Only<br/>Questions? <a href="mailto:support@vantalabsresearch.com" style="color:#a1a1aa;">support@vantalabsresearch.com</a></p>
          ${input.footerNoteHtml ?? ""}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function toText(lines: Array<string | null | false | undefined>) {
  return lines.filter((line): line is string => Boolean(line) || line === "").join("\n");
}

export function couponAnnouncementTemplate(input: {
  headline: string;
  code: string;
  discountLabel: string;
  message?: string;
  endsAt?: string | null;
  shopUrl: string;
}): EmailTemplate {
  const code = escapeHtml(input.code);
  const discountLabel = escapeHtml(input.discountLabel);
  const headline = escapeHtml(input.headline);
  const message = input.message ? `<p>${escapeHtml(input.message)}</p>` : "";
  // Pinned to the display zone like every other customer-facing date, so the
  // offer's end date reads the same wherever this is rendered or sent from.
  const expiryHuman = formatDisplayDate(input.endsAt, "long");
  const expiryHtml = expiryHuman ? `<p style="margin:12px 0 0;font-size:12px;color:#a1a1aa;">Offer ends ${escapeHtml(expiryHuman)}.</p>` : "";
  const codeBlock = `<div style="margin:18px 0 4px;padding:14px;border:1px dashed rgba(255,255,255,0.35);border-radius:12px;text-align:center;"><span style="font-size:20px;font-weight:800;letter-spacing:0.14em;color:#ffffff;">${code}</span></div>`;

  return {
    subject: `${input.headline} — use code ${input.code}`,
    html: renderLayout({
      preheader: `${input.discountLabel} with code ${input.code}`,
      titleHtml: headline,
      bodyHtml: `${message}<p>Use this code at checkout for <strong style="color:#ffffff;">${discountLabel}</strong>:</p>${codeBlock}${expiryHtml}`,
      ctaLabel: "Shop Now",
      ctaUrl: input.shopUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      input.headline,
      "",
      input.message || false,
      input.message ? "" : false,
      `Use code ${input.code} at checkout for ${input.discountLabel}.`,
      expiryHuman ? `Offer ends ${expiryHuman}.` : false,
      "",
      `Shop now: ${input.shopUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

// THE ACCOUNT-CONFIRMATION TEMPLATE IS BACK, AND IT IS NOW SENT.
//
// It used to sit at this spot unused, which was worse than dead code: it made
// settings.ts's claim that verification "flows through the same sendEmail()"
// look true at a glance, and that claim hid the fact that nothing monitored
// confirmation delivery at all. It was then deleted, and the note left in its
// place said this app COULD NOT take the email over, because
// `generateLink({ type: "signup" })` needs a password we do not hold.
//
// That was right about an EXISTING unconfirmed account and wrong about the
// moment that matters. At signup the person has just typed their password, so
// a server route holds it and can mint the link — which is what
// /api/auth/signup now does. The old constraint is still real for the RESEND
// case, and that case is served by a magic link instead.
//
// WHY IT WAS WORTH MOVING (2026-08-29).
//
// Supabase's default confirmation email is unstyled HTML: a bare <h2>, one
// sentence, and a naked <a>. It is well-formed and it delivers — Resend
// reported "delivered" for every stuck account — and it still did not work,
// because that shape is indistinguishable from phishing and Gmail filed it
// accordingly. Four of nine signups over four days never confirmed, while the
// order confirmations rendered by renderLayout above, on the same domain
// through the same Resend account, landed every time.
//
// Sending it from here fixes three things at once: it renders branded like
// every other message, it goes out from the identity an operator configured in
// Admin → Settings, and it becomes visible to the bounce webhook and the send
// log. The last one is the point. This email was the only piece of the system
// with no telemetry at all, which is why a customer had to report it.

export function accountConfirmationTemplate(input: { name: string; confirmUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Confirm your Vanta Labs account",
    html: renderLayout({
      preheader: "One tap to finish setting up your account.",
      titleHtml: name ? `Welcome, ${name}` : "Confirm your email",
      bodyHtml: `<p>Tap the button below to confirm this email address and finish setting up your Vanta Labs account.</p><p>If you didn't create an account, you can ignore this email and nothing will happen.</p>`,
      ctaLabel: "Confirm my email",
      ctaUrl: input.confirmUrl,
    }),
    text: toText([
      name ? `Welcome, ${input.name},` : "Welcome,",
      "",
      "Confirm this email address to finish setting up your Vanta Labs account:",
      input.confirmUrl,
      "",
      "If you didn't create an account, you can ignore this email.",
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * The same confirmation, for someone whose account already exists unconfirmed.
 *
 * A signup link cannot be re-minted for them — `generateLink({ type: "signup" })`
 * needs the password, and we do not store it — so the resend is a MAGIC LINK.
 * Verifying one confirms the address and signs them in, which is the outcome
 * they were waiting for either way, and it is the only branded route back for
 * an account already stranded by a confirmation that never arrived.
 */
export function accountConfirmationResendTemplate(input: { name: string; confirmUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Your Vanta Labs sign-in link",
    html: renderLayout({
      preheader: "Finish setting up your account.",
      titleHtml: name ? `Welcome back, ${name}` : "Finish setting up your account",
      bodyHtml: `<p>Tap the button below to confirm your email address and sign in. This link expires shortly and can only be used once.</p><p>If you didn't ask for this, you can ignore this email.</p>`,
      ctaLabel: "Confirm and sign in",
      ctaUrl: input.confirmUrl,
    }),
    text: toText([
      name ? `Welcome back, ${input.name},` : "Welcome back,",
      "",
      "Confirm your email address and sign in:",
      input.confirmUrl,
      "",
      "This link expires shortly and can only be used once.",
      "If you didn't ask for this, you can ignore this email.",
      "",
      "- Vanta Labs",
    ]),
  };
}

// Password reset is the same shape and was moved first: see
// passwordResetTemplate below, sent by /api/auth/password-reset.

export function passwordResetTemplate(input: { name: string; resetUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Reset your Vanta Labs password",
    html: renderLayout({
      preheader: "Reset your password.",
      titleHtml: `Hi ${name}, reset your password`,
      bodyHtml: `<p>We received a request to reset your password. Click below to choose a new one. This link expires shortly for your security.</p><p>If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
      ctaLabel: "Reset Password",
      ctaUrl: input.resetUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "We received a request to reset your password. Use the link below to choose a new one:",
      input.resetUrl,
      "",
      "If you didn't request this, you can safely ignore this email.",
      "",
      "- Vanta Labs",
    ]),
  };
}

export function orderConfirmationTemplate(input: {
  customerName: string;
  orderId: string;
  items: Array<{ name: string; quantity: number; lineTotal: number }>;
  subtotal: number;
  shipping: number;
  discount: number;
  tax?: number;
  cardProcessingFee?: number;
  total: number;
  orderUrl?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const tax = input.tax ?? 0;
  const cardFee = input.cardProcessingFee ?? 0;
  // Reconcile the receipt against the ACTUAL charged Total. The residual of
  // (subtotal + shipping + tax + fee − total) is either net reductions (promo
  // discount + points + store credit) when positive, or a net add-on (e.g. the
  // shipping-protection fee, which is folded into the total and not stored as a
  // separate column) when negative. Splitting it this way means the line items
  // ALWAYS sum to Total, whether the order had discounts, an add-on, or both.
  const residual = Math.round((input.subtotal + input.shipping + tax + cardFee - input.total) * 100) / 100;

  // ...BUT THE PROMO DISCOUNT IS NOT PART OF THAT RESIDUAL'S JOB.
  //
  // savings and addOn used to be the two halves of the residual alone, and
  // `input.discount` — a stored column every caller passes — was never read. So
  // an order with BOTH a discount and an add-on netted them against each other
  // and printed the difference as the discount. A $20 promo on an order that
  // also bought $15 of shipping protection nets to $5, and the receipt said
  // "Discounts & credits -$5.00" with no protection line to account for the
  // other fifteen. Not rounding: a different number, on the document customers
  // reconcile against their card statement.
  //
  // So the discount is taken out first and shown as itself, and the residual
  // keeps its original job for everything that is NOT itemised — points and
  // store credit when what is left is a reduction, an add-on when it is a
  // charge. The lines still sum to Total, which is the property the residual
  // existed for.
  //
  // A discount larger than the whole order is not believed. It would imply an
  // add-on of the difference, which is never real, and printing it would turn a
  // bad stored value into a nonsensical receipt; the residual alone is the
  // safer answer there, and it is what this did before.
  const gross = Math.round((input.subtotal + input.shipping + tax + cardFee) * 100) / 100;
  const discount = input.discount > 0 && input.discount <= gross ? input.discount : 0;
  const other = Math.round((residual - discount) * 100) / 100;
  const credits = Math.max(0, other);
  const addOn = Math.max(0, -other);
  const rows = input.items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;color:#e4e4e7;">${escapeHtml(item.name)} × ${item.quantity}</td><td style="padding:6px 0;text-align:right;color:#e4e4e7;">${money(item.lineTotal)}</td></tr>`,
    )
    .join("");
  const summaryRow = (label: string, value: string, opts?: { border?: boolean; bold?: boolean }) => {
    const base = opts?.border ? "padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);" : "padding:2px 0;";
    const color = opts?.bold ? "color:#ffffff;font-weight:700;" : "color:#a1a1aa;";
    return `<tr><td style="${base}${color}">${label}</td><td style="${base}text-align:right;${color}">${value}</td></tr>`;
  };

  return {
    subject: `Order Confirmed - ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} is confirmed.`,
      titleHtml: `Thanks, ${name}. Your order is confirmed.`,
      bodyHtml: `
        <p>Order <strong>${escapeHtml(input.orderId)}</strong> has been received and is being prepared.</p>
        <table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">
          ${rows}
          ${summaryRow("Subtotal", money(input.subtotal), { border: true })}
          ${summaryRow("Shipping", money(input.shipping))}
          ${discount > 0 ? summaryRow("Discount", `-${money(discount)}`) : ""}
          ${credits > 0 ? summaryRow("Credits applied", `-${money(credits)}`) : ""}
          ${tax > 0 ? summaryRow("Sales tax", money(tax)) : ""}
          ${cardFee > 0 ? summaryRow(escapeHtml(CARD_FEE_LABEL), money(cardFee)) : ""}
          ${addOn > 0 ? summaryRow("Shipping protection", money(addOn)) : ""}
          ${summaryRow("Total", money(input.total), { bold: true })}
        </table>
      `,
      ctaLabel: input.orderUrl ? "View order" : undefined,
      ctaUrl: input.orderUrl,
    }),
    text: toText([
      `Thanks, ${input.customerName || "there"}.`,
      "",
      `Order ${input.orderId} has been received and is being prepared.`,
      "",
      ...input.items.map((item) => `${item.name} x ${item.quantity} - ${money(item.lineTotal)}`),
      "",
      `Subtotal: ${money(input.subtotal)}`,
      `Shipping: ${money(input.shipping)}`,
      discount > 0 ? `Discount: -${money(discount)}` : null,
      credits > 0 ? `Credits applied: -${money(credits)}` : null,
      tax > 0 ? `Sales tax: ${money(tax)}` : null,
      cardFee > 0 ? `${CARD_FEE_LABEL}: ${money(cardFee)}` : null,
      addOn > 0 ? `Shipping protection: ${money(addOn)}` : null,
      `Total: ${money(input.total)}`,
      input.orderUrl ? "" : null,
      input.orderUrl ? `View your order: ${input.orderUrl}` : null,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * Sent AFTER the owner has already sent the money externally and recorded it.
 *
 * Deliberately does not say "returned to your original payment method" — that
 * is the one sentence that would be false. Vanta's software never moves money
 * on this path; the owner reimburses the customer directly through the method
 * they agreed, and this message confirms it has been done. Naming the method
 * here would put the owner's payment handles in a forwardable email for no
 * benefit to the customer, so it says only that it has been processed.
 */
export function reimbursementRecordedTemplate(input: {
  customerName: string;
  orderId: string;
  amount: number;
  supportEmail?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const support = input.supportEmail ? escapeHtml(input.supportEmail) : null;
  const orderRef = escapeHtml(input.orderId);
  return {
    subject: `Reimbursement processed - ${input.orderId}`,
    html: renderLayout({
      preheader: `Your reimbursement of ${money(input.amount)} for order ${input.orderId} has been processed.`,
      titleHtml: "Your reimbursement has been processed",
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>Your reimbursement for order <strong>${orderRef}</strong> has been processed by Vanta Labs.</p>
        <table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">
          <tr><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);color:#ffffff;font-weight:700;">Amount</td><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);text-align:right;color:#ffffff;font-weight:700;">${money(input.amount)}</td></tr>
        </table>
        ${support ? `<p style="margin-top:16px;color:#a1a1aa;">Any questions? Contact us at ${support}.</p>` : ""}
      `,
    }),
    text: toText([
      `Hi ${input.customerName || "there"},`,
      "",
      `Your reimbursement for order ${input.orderId} has been processed by Vanta Labs.`,
      "",
      `Amount: ${money(input.amount)}`,
      "",
      support ? `Questions? Contact ${input.supportEmail}.` : null,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function refundConfirmationTemplate(input: {
  customerName: string;
  orderId: string;
  refundAmount: number;
  isFullRefund: boolean;
  supportEmail?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const kind = input.isFullRefund ? "full refund" : "partial refund";
  const support = input.supportEmail ? escapeHtml(input.supportEmail) : null;
  return {
    subject: `Refund processed - ${input.orderId}`,
    html: renderLayout({
      preheader: `A ${kind} of ${money(input.refundAmount)} has been issued for order ${input.orderId}.`,
      titleHtml: `Your refund has been processed`,
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>We've issued a <strong>${kind}</strong> for order <strong>${escapeHtml(input.orderId)}</strong>.</p>
        <table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">
          <tr><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);color:#ffffff;font-weight:700;">Refund amount</td><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);text-align:right;color:#ffffff;font-weight:700;">${money(input.refundAmount)}</td></tr>
        </table>
        <p style="margin-top:16px;color:#a1a1aa;">Refunds are returned to your original payment method. Depending on your bank or card issuer, it can take 5–10 business days to appear on your statement.</p>
        ${support ? `<p style="color:#a1a1aa;">Questions about this refund? Contact us at ${support}.</p>` : ""}
      `,
    }),
    text: toText([
      `Hi ${input.customerName || "there"},`,
      "",
      `We've issued a ${kind} for order ${input.orderId}.`,
      "",
      `Refund amount: ${money(input.refundAmount)}`,
      "",
      "Refunds are returned to your original payment method and can take 5-10 business days to appear.",
      support ? `Questions? Contact ${input.supportEmail}.` : null,
      "",
      "- Vanta Labs",
    ]),
  };
}

function paymentMethodLabel(method: string) {
  switch (method) {
    case "card":
      return "Credit / Debit Card";
    default:
      return method;
  }
}

export function manualPaymentReceivedTemplate(input: {
  customerName: string;
  orderNumber: string;
  amount: number;
  paymentMethod: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const method = escapeHtml(paymentMethodLabel(input.paymentMethod));
  return {
    subject: `Payment received — verifying order ${input.orderNumber}`,
    html: renderLayout({
      preheader: `We received your ${method} payment details for ${input.orderNumber}.`,
      titleHtml: `Thanks, ${name}. We're verifying your payment.`,
      bodyHtml: `
        <p>We've received your <strong>${method}</strong> payment details for order <strong>${escapeHtml(input.orderNumber)}</strong>.</p>
        <p>Amount: <strong>${money(input.amount)}</strong></p>
        <p>Our team is verifying your payment now. You'll get another email as soon as it's approved and your order moves to fulfillment. This usually happens quickly during business hours.</p>
      `,
    }),
    text: toText([
      `Thanks, ${input.customerName || "there"}.`,
      "",
      `We've received your ${paymentMethodLabel(input.paymentMethod)} payment details for order ${input.orderNumber}.`,
      `Amount: ${money(input.amount)}`,
      "",
      "Our team is verifying your payment now. You'll get another email as soon as it's approved.",
      "",
      "- Vanta Labs",
    ]),
  };
}

// Internal alert to the business when a customer submits a manual payment that
// needs verifying — so the owner doesn't have to keep refreshing the admin.
export function newPaymentToVerifyTemplate(input: {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
  adminUrl: string;
}): EmailTemplate {
  return {
    subject: `New payment to verify — ${input.orderNumber} (${money(input.amount)})`,
    html: renderLayout({
      preheader: `${paymentMethodLabel(input.paymentMethod)} payment submitted for ${input.orderNumber}.`,
      titleHtml: `New ${escapeHtml(paymentMethodLabel(input.paymentMethod))} payment to verify`,
      bodyHtml: `
        <p>Order <strong>${escapeHtml(input.orderNumber)}</strong> — <strong>${money(input.amount)}</strong></p>
        <p>Customer: ${escapeHtml(input.customerName || "—")} (${escapeHtml(input.customerEmail)})<br/>
        Method: ${escapeHtml(paymentMethodLabel(input.paymentMethod))}<br/>
        Transaction ID: ${escapeHtml(input.transactionId)}</p>
        <p>Review and approve it in your admin dashboard.</p>
      `,
      ctaLabel: "Open Payment Verification",
      ctaUrl: input.adminUrl,
    }),
    text: toText([
      `New ${paymentMethodLabel(input.paymentMethod)} payment to verify.`,
      "",
      `Order ${input.orderNumber} — ${money(input.amount)}`,
      `Customer: ${input.customerName || "—"} (${input.customerEmail})`,
      `Transaction ID: ${input.transactionId}`,
      "",
      input.adminUrl,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function manualPaymentRejectedTemplate(input: {
  customerName: string;
  orderNumber: string;
  reason?: string;
  resubmitUrl: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const reasonLine = input.reason
    ? `<p>Reason: ${escapeHtml(input.reason)}</p>`
    : "";
  return {
    subject: `Action needed — payment not verified for ${input.orderNumber}`,
    html: renderLayout({
      preheader: `We couldn't verify the payment for order ${input.orderNumber}.`,
      titleHtml: `${name}, we couldn't verify your payment`,
      bodyHtml: `
        <p>We weren't able to verify the payment for order <strong>${escapeHtml(input.orderNumber)}</strong>.</p>
        ${reasonLine}
        <p>Please double-check the payment and re-submit your transaction ID (and a screenshot if you have one). Make sure your Order Number is included in the payment note.</p>
      `,
      ctaLabel: "Re-submit Payment",
      ctaUrl: input.resubmitUrl,
    }),
    text: toText([
      `${input.customerName || "there"}, we couldn't verify your payment.`,
      "",
      `Order ${input.orderNumber} payment was not verified.`,
      input.reason ? `Reason: ${input.reason}` : null,
      "",
      `Re-submit your payment: ${input.resubmitUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function shippingUpdateTemplate(input: {
  customerName: string;
  orderId: string;
  status: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const carrierLine = input.carrier ? `Carrier: ${escapeHtml(input.carrier)}<br/>` : "";
  const trackingLine = input.trackingNumber
    ? `<p>${carrierLine}Tracking number: ${escapeHtml(input.trackingNumber)}</p>`
    : "";

  return {
    subject: `Shipping Update - ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} status: ${input.status}.`,
      titleHtml: `${name}, your order status changed`,
      bodyHtml: `<p>Order <strong>${escapeHtml(input.orderId)}</strong> is now: <strong>${escapeHtml(input.status)}</strong>.</p>${trackingLine}`,
      ctaLabel: input.trackingUrl ? "Track Package" : undefined,
      ctaUrl: input.trackingUrl,
    }),
    text: toText([
      `${input.customerName || "there"}, your order status changed.`,
      "",
      `Order ${input.orderId} is now: ${input.status}.`,
      // Only when the carrier was actually recognised — this printed a bare
      // "Carrier: " line whenever the name was missing or withheld.
      input.trackingNumber && input.carrier ? `Carrier: ${input.carrier}` : null,
      input.trackingNumber ? `Tracking number: ${input.trackingNumber}` : null,
      input.trackingUrl ?? null,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function replacementOrderTemplate(input: {
  customerName: string;
  originalOrderNumber: string;
  replacementOrderNumber: string;
  items: Array<{ name: string; quantity: number }>;
  supportEmail?: string;
  orderUrl?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const itemRows = input.items
    .map((item) => `<tr><td style="padding:6px 0;color:#d4d4d8;">${escapeHtml(item.name)}</td><td style="padding:6px 0;text-align:right;color:#d4d4d8;">× ${Math.max(1, Math.floor(item.quantity))}</td></tr>`)
    .join("");
  const support = input.supportEmail ? escapeHtml(input.supportEmail) : null;
  return {
    subject: `Your replacement is on the way — ${input.replacementOrderNumber}`,
    html: renderLayout({
      preheader: `We're sending a replacement for order ${input.originalOrderNumber} at no charge.`,
      titleHtml: `Your replacement is on the way`,
      bodyHtml: `
        <p>Hi ${name},</p>
        <p>We're sorry your order <strong>${escapeHtml(input.originalOrderNumber)}</strong> didn't arrive in perfect condition. A replacement is being prepared and shipped to you <strong>at no charge</strong>.</p>
        <table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">
          <tr><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);color:#ffffff;font-weight:700;">Replacement order</td><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);text-align:right;color:#ffffff;font-weight:700;">${escapeHtml(input.replacementOrderNumber)}</td></tr>
          ${itemRows}
        </table>
        <p style="margin-top:14px;">You'll receive a shipping confirmation with tracking as soon as it leaves the warehouse. Nothing is charged and nothing else is needed from you.</p>
        ${support ? `<p style="margin-top:10px;color:#a1a1aa;">Questions? Reach us at <a href="mailto:${support}" style="color:#e8d5a4;">${support}</a>.</p>` : ""}
      `,
      ctaLabel: input.orderUrl ? "Track my replacement" : undefined,
      ctaUrl: input.orderUrl,
    }),
    text: [
      `Hi ${input.customerName || "there"},`,
      ``,
      `We're sorry your order ${input.originalOrderNumber} didn't arrive in perfect condition.`,
      `A replacement (${input.replacementOrderNumber}) is being prepared and shipped at no charge:`,
      ...input.items.map((item) => `  - ${item.name} × ${Math.max(1, Math.floor(item.quantity))}`),
      ``,
      `You'll receive tracking as soon as it ships. Nothing is charged.`,
      ...(input.orderUrl ? [``, `Track your replacement: ${input.orderUrl}`] : []),
    ].join("\n"),
  };
}

export function deliveryConfirmationTemplate(input: {
  customerName: string;
  orderId: string;
  shopUrl?: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  return {
    subject: `Delivered — order ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} has been delivered.`,
      titleHtml: `${name}, your order was delivered`,
      bodyHtml: `<p>Order <strong>${escapeHtml(input.orderId)}</strong> has been marked <strong>delivered</strong>. We hope everything arrived in great shape.</p><p>If anything's not right, just reply to this email and we'll help.</p>`,
      ctaLabel: input.shopUrl ? "Explore Vanta" : undefined,
      ctaUrl: input.shopUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      `${input.customerName || "there"}, your order was delivered.`,
      "",
      `Order ${input.orderId} has been marked delivered.`,
      "If anything's not right, reply to this email and we'll help.",
      input.shopUrl ? "" : null,
      input.shopUrl ? `Explore the catalog: ${input.shopUrl}` : null,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * The email an ADMIN-INVITED ambassador gets. Branded, and ours to send.
 *
 * createPartnerInvite used to leave this to `auth.admin.inviteUserByEmail`,
 * which mails Supabase's unstyled "Invite user" template — the same bare-anchor
 * shape that got signup confirmations filed as phishing. It matters more here,
 * not less: inviteUserByEmail creates the account with NO password, so this
 * link is the ONLY way that person ever gets one. Ambassador ZAIN was invited
 * on 2026-08-23 and approved an hour later with a live referral code, and six
 * days on had still never confirmed or signed in.
 */
export function ambassadorInviteTemplate(input: { name: string; inviteUrl: string; commissionPercent?: number }): EmailTemplate {
  const name = escapeHtml(input.name);
  const rate = typeof input.commissionPercent === "number" && Number.isFinite(input.commissionPercent)
    ? `<p>Your commission rate is set to <strong>${escapeHtml(String(input.commissionPercent))}%</strong>.</p>`
    : "";
  return {
    subject: "You're invited to the Vanta Labs ambassador program",
    html: renderLayout({
      preheader: "Set your password and pick up your referral link.",
      titleHtml: name ? `${name}, you're in` : "You're invited",
      bodyHtml:
        `<p>You've been invited to the Vanta Labs ambassador program. Tap below to set a password and open your dashboard, where your referral link and earnings live.</p>`
        + rate
        + `<p>This link can only be used once. If it expires, use “Forgot your password?” on the sign-in page with this address.</p>`,
      ctaLabel: "Set my password",
      ctaUrl: input.inviteUrl,
    }),
    text: toText([
      name ? `${input.name},` : "Hello,",
      "",
      "You've been invited to the Vanta Labs ambassador program.",
      "Set a password and open your dashboard:",
      input.inviteUrl,
      "",
      typeof input.commissionPercent === "number" && Number.isFinite(input.commissionPercent)
        ? `Your commission rate is set to ${input.commissionPercent}%.`
        : "",
      "This link can only be used once. If it expires, use \"Forgot your password?\" with this address.",
      "",
      "- Vanta Labs",
    ]),
  };
}

export function ambassadorApplicationReceivedTemplate(input: { name: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Your Vanta Labs Ambassador Application Was Received",
    html: renderLayout({
      preheader: "Your application is under review.",
      titleHtml: `Thanks for applying, ${name}`,
      bodyHtml: `<p>Your ambassador application has been received and is under review. Most applications are reviewed within 24 hours — we'll email you as soon as a decision is made.</p>`,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Thank you for applying to the Vanta Labs ambassador program. Your application has been received and is under review.",
      "Most applications are reviewed within 24 hours.",
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * THE APPROVAL EMAIL HAS TO CARRY THE LINK, NOT JUST THE CODE.
 *
 * It named the code and stopped there. The shareable link — /r/CODE, which is
 * what actually sets the referral cookie and credits the ambassador — went out
 * only in `referralCodeAssignedTemplate`, and that fires on
 * `referralCodeChanged`. Approve someone whose code was already on their row
 * and the condition is false, so the link is never sent at all.
 *
 * Not hypothetical: ambassador DREW was approved 2026-08-31 with the code
 * already stored. `notification_queue` holds exactly two rows for that address
 * — application received, application approved — and no referral-code mail. He
 * had a live code, a working /r/DREW redirect, and no way to learn the URL
 * existed. He asked for it by hand.
 *
 * So the link is built here from the code rather than taken as a required
 * field: a caller that forgets cannot reintroduce the hole, the same reasoning
 * `sendPartnerStatusEmail` already applies to the commission rate.
 *
 * Keep the parameter list free of comments: templates-sweep.test.ts derives its
 * fixture by parsing this signature's text, and a comment inside the braces
 * hides the fields after it.
 */
export function ambassadorApprovedTemplate(input: {
  name: string;
  referralCode?: string;
  siteUrl?: string;
  dashboardUrl: string;
  commissionPercent?: number;
  personalDiscountPercent?: number;
  referralDiscountPercent?: number;
  holdDays?: number;
  minimumQualifyingOrder?: number;
}): EmailTemplate {
  // minimumQualifyingOrder: orders below this subtotal are attributed but earn
  // nothing, so the email says so beside the rate. (Kept out of the signature
  // braces for the same parser reason as campaignTemplate.)
  const name = escapeHtml(input.name);
  const code = input.referralCode ? escapeHtml(input.referralCode) : null;
  const minimumQualifying = typeof input.minimumQualifyingOrder === "number" && Number.isFinite(input.minimumQualifyingOrder) && input.minimumQualifyingOrder > 0
    ? ` of $${Math.round(input.minimumQualifyingOrder)} or more`
    : "";
  // Derived from dashboardUrl when no siteUrl is given: the dashboard already
  // IS an absolute URL on this origin, so its origin is the one the link must
  // share. Falls back to null rather than a relative href — a bare "/r/CODE"
  // in an email body is dead text.
  const linkOrigin = (input.siteUrl || input.dashboardUrl || "").trim();
  const referralCodeRaw = input.referralCode;
  const referralLink = referralCodeRaw && linkOrigin
    ? (() => {
        try {
          return new URL(`/r/${encodeURIComponent(referralCodeRaw)}`, linkOrigin).toString();
        } catch {
          return null;
        }
      })()
    : null;
  const referralLinkHtml = referralLink ? escapeHtml(referralLink) : null;
  // The programme defaults, not literal 10/20/10 — same reason as holdDays
  // below: these fire whenever the caller cannot resolve the live value, and a
  // copy here would keep quoting the old rate to new ambassadors after the
  // programme's was changed. admin-control-shared.ts is the client-safe home
  // for them; admin-control.ts is `server-only` and cannot be imported here.
  const commissionPct = Number.isFinite(input.commissionPercent) ? Number(input.commissionPercent) : DEFAULT_AMBASSADOR_COMMISSION_PERCENT;
  const personalPct = Number.isFinite(input.personalDiscountPercent) ? Number(input.personalDiscountPercent) : DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT;
  const referralPct = Number.isFinite(input.referralDiscountPercent) ? Number(input.referralDiscountPercent) : DEFAULT_REFERRAL_DISCOUNT_PERCENT;
  // The programme default (30), not a literal 14 — the approval email told
  // new ambassadors the wrong hold whenever the caller could not resolve the
  // configured value.
  const holdDays = Number.isFinite(input.holdDays) ? Number(input.holdDays) : DEFAULT_COMMISSION_HOLD_DAYS;

  // WHAT AN APPROVED AMBASSADOR NEEDS, AND NOTHING ELSE.
  //
  // This was 371 words and 21 promotional terms — "Cash bonuses", "Free
  // products", "no fixed ceiling on what top performers can earn", giveaways,
  // exclusive promotions — sent as TRANSACTIONAL mail: no List-Unsubscribe, no
  // postal address, no Reply-To. Promotional body plus none of the three things
  // that make promotional mail legitimate is the exact shape bulk filters score
  // against, and this message is the one an ambassador cannot afford to miss:
  // it is the only place their code, rate and link are delivered.
  //
  // The growth/bonus material is not deleted, it is MOVED — the dashboard is
  // where it can be kept current, and where quoting an incentive is not a
  // promise stamped into someone's inbox for ever. What stays is the operative
  // facts and one route to a human.
  const bodyHtml = `
    <p>Congratulations, ${name} — your application to the Vanta Labs Ambassador Program has been <strong>approved</strong>.</p>
    ${code ? `<p><strong>Your referral code:</strong> ${code} — customers who use it get <strong>${referralPct}% off</strong>.</p>` : ""}
    ${referralLinkHtml ? `<p style="margin-top:12px"><strong>Your referral link — share this one, it credits you automatically:</strong></p>
    <p style="font-size:13px;word-break:break-all;"><a href="${referralLinkHtml}" style="color:#c9a227;">${referralLinkHtml}</a></p>
    <p style="font-size:13px;color:#a1a1aa;">Anyone who opens it has the discount applied without typing anything. The code still works on its own for people who would rather enter it at checkout.</p>` : ""}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid rgba(255,255,255,0.12);border-bottom:1px solid rgba(255,255,255,0.12);">
      <tr>
        <td style="padding:14px 0;font-size:13px;color:#a1a1aa;">Your commission</td>
        <td style="padding:14px 0;font-size:15px;color:#f4f4f4;font-weight:700;" align="right">${commissionPct}%</td>
      </tr>
      <tr>
        <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-size:13px;color:#a1a1aa;">Your customers' discount</td>
        <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-size:15px;color:#f4f4f4;font-weight:700;" align="right">${referralPct}%</td>
      </tr>
      <tr>
        <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-size:13px;color:#a1a1aa;">Your own discount</td>
        <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,0.08);font-size:15px;color:#f4f4f4;font-weight:700;" align="right">${personalPct}%</td>
      </tr>
    </table>
    <p style="margin-top:10px;font-size:12px;color:#71717a;">Your own discount applies at the cart automatically while you are signed in — no code needed.</p>

    <p style="margin-top:20px"><strong>How you get paid</strong></p>
    <p>You earn ${commissionPct}% of the merchandise total on each completed order${minimumQualifying} placed with your code. A commission is held for ${holdDays} days after the order completes, which covers refunds and chargebacks, then is included in the next payout. Payouts run every two weeks by PayPal, Venmo, or Cash App.</p>
    <p>Open your dashboard to choose your payout method, copy your link, and track pending, approved, and paid commissions. Full program terms, requirements, and current incentives live there too.</p>

    <p style="margin-top:16px;font-size:13px;color:#a1a1aa;">Questions about the program or your account? Reply to this email and our team will help.</p>
  `;

  return {
    subject: "You're approved — Vanta Labs ambassador program",
    html: renderLayout({
      preheader: "You're approved. Set your payout method and start sharing.",
      titleHtml: `You're approved, ${name}!`,
      bodyHtml,
      ctaLabel: "Open Your Dashboard",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Congratulations — your Vanta Labs Ambassador application has been approved.",
      code ? `Your referral code: ${input.referralCode} (customers get ${referralPct}% off).` : null,
      referralLink ? `Your referral link (share this one — it credits you automatically): ${referralLink}` : null,
      `Personal discount: ${personalPct}% off your own purchases while approved (auto-applied at checkout when signed in).`,
      "",
      `Your commission: ${commissionPct}% of the merchandise total on each completed order placed with your code.`,
      `Your customers' discount: ${referralPct}%.`,
      `Your own discount: ${personalPct}% off your own purchases, applied at the cart while signed in (no code needed).`,
      "",
      `How you get paid: a commission is held for ${holdDays} days after the order completes, which covers refunds and chargebacks, then is included in the next payout. Payouts run every two weeks by PayPal, Venmo, or Cash App. Refunded or cancelled orders never pay.`,
      "",
      "Open your dashboard to choose your payout method, copy your link, and track pending, approved and paid commissions. Full program terms, requirements and current incentives live there.",
      "",
      "Questions about the program or your account? Reply to this email and our team will help.",
      "",
      `Dashboard: ${input.dashboardUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

// Sent to an ambassador when their commissions are paid out. Confirms the
// amount, the method used, the number of orders covered, and the date.
export function ambassadorPayoutSentTemplate(input: {
  name: string;
  amount: number;
  method: string;
  handle?: string | null;
  orderCount: number;
  dashboardUrl: string;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  const amount = `$${Number(input.amount ?? 0).toFixed(2)}`;
  const method = escapeHtml(input.method || "your chosen method");
  const handle = input.handle ? escapeHtml(input.handle) : null;
  return {
    subject: `Your Vanta Labs payout of ${amount} is on the way`,
    html: renderLayout({
      preheader: `We've sent your ${amount} ambassador payout.`,
      titleHtml: `Payment sent, ${name}`,
      bodyHtml: `
        <p>Good news — we've sent your ambassador payout.</p>
        <ul>
          <li><strong>Amount:</strong> ${amount}</li>
          <li><strong>Method:</strong> ${method}${handle ? ` (${handle})` : ""}</li>
          <li><strong>Orders covered:</strong> ${Number(input.orderCount ?? 0)}</li>
        </ul>
        <p>The paid commissions have moved to your payout history. Thank you for representing Vanta Labs.</p>
      `,
      ctaLabel: "View Payout History",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "We've sent your ambassador payout.",
      `Amount: ${amount}`,
      `Method: ${input.method}${input.handle ? ` (${input.handle})` : ""}`,
      `Orders covered: ${Number(input.orderCount ?? 0)}`,
      "",
      `Payout history: ${input.dashboardUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * "We need a bit more information" — the ambassador status that told nobody.
 *
 * /partner/pending has always rendered, for status = info_requested: "Please
 * reply to the email we sent." No email was ever sent. updatePartnerStatus
 * gated its notification on approved/rejected only, so an applicant moved to
 * this state was left on a page pointing at a message that did not exist, with
 * nothing to reply to and no idea what was wanted.
 *
 * The copy deliberately does not invent a list of what is missing — the admin
 * UI has no field for one — so it asks them to reply, which reaches the support
 * address and is the action the page has always described.
 */
/**
 * "Confirm your new email address."
 *
 * THE LAST CUSTOMER-FACING AUTH EMAIL SUPABASE STILL SENT FOR US.
 *
 * Changing an email in /account/settings called supabase.auth.updateUser({
 * email }) from the browser, so GoTrue mailed its own unstyled template, from
 * Supabase's identity, with a button pointing at
 * https://<project>.supabase.co/auth/v1/verify — an off-domain link in an
 * unbranded message, invisible to the send log, the retry queue and the bounce
 * webhook. That is the exact shape Gmail filed as spam on 2026-08-29, stripping
 * its links so there was nothing to click. Signup, resend, password reset and
 * the ambassador invite were all moved in-house; this one was missed, while the
 * UI promised "Check your new email address to confirm the change."
 *
 * Keep the parameter list free of comments — see campaignTemplate.
 */
/**
 * "Your order has been cancelled."
 *
 * There was no cancellation template at all, and no path that could have sent
 * one: notificationFor() emits a notification only for `delivered` or for
 * entering the carrier network, so the fulfilment writer says nothing for
 * `cancelled`. FULFILLMENT_TRANSITIONS permits cancelling from `paid`, so this
 * covered orders the customer had ALREADY BEEN CHARGED for — they received an
 * "Order Confirmed" email, then silence, and kept waiting for a shipping notice
 * that was never coming. The only trace was an in-app row they had to log in
 * and go looking for.
 *
 * `refundNote` is written by the operator. It is the one place to say what
 * happens to the money, which is the customer's first question.
 *
 * Keep the parameter list free of comments — see campaignTemplate.
 */
export function orderCancelledTemplate(input: {
  customerName: string;
  orderId: string;
  reason?: string | null;
  refundNote?: string | null;
  supportEmail?: string | null;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const reason = String(input.reason ?? "").trim();
  const refundNote = String(input.refundNote ?? "").trim();
  // THE LAYOUT FOOTER ALREADY PRINTS A SUPPORT ADDRESS.
  //
  // Found by rendering this template in a browser, not by a unit test: the
  // footer read "Questions? support@vantalabsresearch.com" from renderLayout
  // and then, immediately under it, "Questions? Reach us at
  // support@vantalabsresearch.com." — the same address twice, two lines apart.
  // This is the only template that adds its own copy of that line.
  //
  // Kept only when a CONFIGURED support address differs from the one the layout
  // hard-codes, which is the single case where the extra line carries
  // information rather than repeating it.
  const LAYOUT_SUPPORT = "support@vantalabsresearch.com";
  const configuredSupport = String(input.supportEmail ?? "").trim();
  const support = escapeHtml(configuredSupport || LAYOUT_SUPPORT);
  const showSupportNote = Boolean(configuredSupport) && configuredSupport.toLowerCase() !== LAYOUT_SUPPORT;
  return {
    subject: `Your Vanta Labs order ${input.orderId} has been cancelled`,
    html: renderLayout({
      preheader: `Order ${input.orderId} was cancelled.`,
      titleHtml: `${name}, your order has been cancelled`,
      bodyHtml:
        `<p>Order <strong>${escapeHtml(input.orderId)}</strong> has been cancelled and will not ship.</p>`
        + (reason ? `<p>${escapeHtml(reason)}</p>` : "")
        // THE FALLBACK PROMISED A REFUND NOTHING ISSUES.
        //
        // It read "the payment is being returned to your original payment
        // method… within 5–10 business days" whenever `refundNote` was absent —
        // and `refundNote` is passed by nothing: the sole caller
        // (api/admin/orders/[orderId]/route.ts) supplies customerName, orderId,
        // reason and supportEmail only. So the fallback always rendered. The
        // cancel block initiates no refund either: it moves the fulfillment
        // status, restocks, writes an audit row and mails. `paid → cancelled`
        // is a permitted transition, so this went to customers whose card had
        // already been charged, telling them money was on its way that nobody
        // had sent.
        //
        // The honest fallback states what is true — the order will not be
        // billed further, and a charge already taken is refunded on request —
        // and routes them to a human. An explicit `refundNote` still wins, so a
        // caller that HAS issued a refund can say so precisely.
        + `<p>${refundNote
            ? escapeHtml(refundNote)
            : "You will not be billed anything further for this order. If you were already charged, reply to this email and we'll return it to your original payment method."}</p>`
        + `<p>If this wasn't expected, reply to this email and we'll sort it out.</p>`,
      footerNoteHtml: showSupportNote
        ? `<p style="margin:10px 0 0;font-size:12px;color:#71717a;">Questions? Reach us at <a href="mailto:${support}" style="color:#a1a1aa;">${support}</a>.</p>`
        : undefined,
    }),
    text: toText([
      `Hi ${input.customerName || "there"},`,
      "",
      `Order ${input.orderId} has been cancelled and will not ship.`,
      reason || null,
      "",
      refundNote
        || "You will not be billed anything further for this order. If you were already charged, "
           + "reply to this email and we'll return it to your original payment method.",
      "",
      `If this wasn't expected, reply to this email or reach us at ${input.supportEmail ?? "support@vantalabsresearch.com"}.`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function emailChangeConfirmationTemplate(input: {
  name: string;
  newEmail: string;
  confirmUrl: string;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Confirm your new Vanta Labs email address",
    html: renderLayout({
      preheader: "One tap confirms the new address on your account.",
      titleHtml: name ? `${name}, confirm your new email` : "Confirm your new email",
      bodyHtml:
        `<p>You asked to change the email address on your Vanta Labs account to <strong>${escapeHtml(input.newEmail)}</strong>.</p>`
        + `<p>Tap the button below to confirm it. Until you do, your account keeps its current address and nothing changes.</p>`,
      ctaLabel: "Confirm my new email",
      ctaUrl: input.confirmUrl,
      footerNoteHtml:
        `<p style="margin:10px 0 0;font-size:12px;color:#71717a;">If you didn't ask for this, ignore this email — the change will not happen — and consider changing your password.</p>`,
    }),
    text: toText([
      name ? `Hi ${input.name},` : "Hi,",
      "",
      `You asked to change the email address on your Vanta Labs account to ${input.newEmail}.`,
      "Confirm it here:",
      "",
      input.confirmUrl,
      "",
      "Until you do, your account keeps its current address and nothing changes.",
      "If you didn't ask for this, ignore this email and consider changing your password.",
      "",
      "- Vanta Labs",
    ]),
  };
}

export function ambassadorInfoRequestedTemplate(input: { name: string; supportEmail?: string; applicationUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  const support = escapeHtml(input.supportEmail ?? "support@vantalabsresearch.com");
  return {
    subject: "One more thing about your Vanta Labs ambassador application",
    html: renderLayout({
      preheader: "We need a little more detail before we can approve you.",
      titleHtml: name ? `${name}, we need one more thing` : "We need one more thing",
      bodyHtml:
        `<p>Thanks for applying to the Vanta Labs ambassador program. Before we can approve you, our team needs a bit more detail about you and your audience.</p>`
        + `<p><strong>Just reply to this email</strong> and tell us a little more — where you post, roughly how many people follow you, and anything else you think helps. We'll pick your review straight back up.</p>`,
      ctaLabel: "View my application",
      ctaUrl: input.applicationUrl,
      footerNoteHtml: `<p style="margin:10px 0 0;font-size:12px;color:#71717a;">You can also reach us at <a href="mailto:${support}" style="color:#a1a1aa;">${support}</a>.</p>`,
    }),
    text: toText([
      name ? `Hi ${input.name},` : "Hi,",
      "",
      "Thanks for applying to the Vanta Labs ambassador program. Before we can",
      "approve you, our team needs a bit more detail about you and your audience.",
      "",
      "Just reply to this email and tell us a little more — where you post,",
      "roughly how many people follow you, and anything else you think helps.",
      "",
      `Your application: ${input.applicationUrl}`,
      `Or reach us at ${input.supportEmail ?? "support@vantalabsresearch.com"}.`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function ambassadorDeniedTemplate(input: { name: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Update on Your Vanta Labs Ambassador Application",
    html: renderLayout({
      preheader: "An update on your application.",
      titleHtml: `Hi ${name}, an update on your application`,
      bodyHtml: `<p>Thank you for applying to the Vanta Labs ambassador program. At this time, your application was not approved.</p><p>You're welcome to reapply in the future as your audience or content evolves.</p>`,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Thank you for applying to the Vanta Labs ambassador program. At this time, your application was not approved.",
      "You may reapply in the future as your audience or content evolves.",
      "",
      "- Vanta Labs",
    ]),
  };
}

// Sent to an ambassador when one of their referred orders is paid and a
// commission is recorded. Deliberately minimal: it must NEVER expose sensitive
// business data (order totals, customer identity, product mix, revenue). Only
// the four fields the owner approved: commission earned on this sale, the
// running unpaid balance, the referral code used, and the biweekly-payout
// reminder.
export function commissionEarnedTemplate(input: {
  name: string;
  commissionAmount: number;
  unpaidBalance: number;
  referralCode?: string;
  dashboardUrl: string;
}): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  const codeLine = input.referralCode
    ? `<p style="margin:4px 0 0;font-size:13px;color:#a1a1aa;">Referral code used: <strong style="color:#e4e4e7;">${escapeHtml(input.referralCode)}</strong></p>`
    : "";
  return {
    subject: `You earned a commission — ${money(input.commissionAmount)}`,
    html: renderLayout({
      preheader: `You earned ${money(input.commissionAmount)} from a new sale.`,
      titleHtml: `Nice work, ${name} — you earned a commission`,
      bodyHtml: `
        <p>A new sale came through your referral. Here's what you earned:</p>
        <p style="margin:14px 0 2px;font-size:22px;font-weight:800;color:#ffffff;">${money(input.commissionAmount)}</p>
        <p style="margin:0;font-size:13px;color:#a1a1aa;">earned on this sale</p>
        <p style="margin:16px 0 0;font-size:15px;color:#e4e4e7;">Running unpaid balance: <strong style="color:#ffffff;">${money(input.unpaidBalance)}</strong></p>
        ${codeLine}
        <p style="margin:16px 0 0;font-size:13px;color:#a1a1aa;">Payouts are processed every two weeks.</p>
      `,
      ctaLabel: "Open Ambassador Dashboard",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Nice work, ${input.name || "there"} — you earned a commission.`,
      "",
      `Commission earned on this sale: ${money(input.commissionAmount)}`,
      `Running unpaid balance: ${money(input.unpaidBalance)}`,
      input.referralCode ? `Referral code used: ${input.referralCode}` : null,
      "",
      "Payouts are processed every two weeks.",
      "",
      `Dashboard: ${input.dashboardUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

// Internal alert to the business owner when a new ambassador application is
// submitted, so they don't have to keep refreshing the admin dashboard.
export function newAmbassadorApplicationTemplate(input: {
  applicantName: string;
  applicantEmail: string;
  adminUrl: string;
}): EmailTemplate {
  return {
    subject: `New ambassador application — ${input.applicantName || input.applicantEmail}`,
    html: renderLayout({
      preheader: `${input.applicantName || input.applicantEmail} applied to the ambassador program.`,
      titleHtml: "New ambassador application",
      bodyHtml: `
        <p>A new ambassador application is awaiting review.</p>
        <p>Applicant: ${escapeHtml(input.applicantName || "—")}<br/>Email: ${escapeHtml(input.applicantEmail)}</p>
        <p>Review and approve or decline it in your admin dashboard.</p>
      `,
      ctaLabel: "Review Applications",
      ctaUrl: input.adminUrl,
    }),
    text: toText([
      "New ambassador application awaiting review.",
      "",
      `Applicant: ${input.applicantName || "—"}`,
      `Email: ${input.applicantEmail}`,
      "",
      input.adminUrl,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * "Your referral code is ready."
 *
 * `dashboardUrl` is the ambassador's own portal, and it is separate from
 * `referralLink` on purpose. The button said "Open my dashboard" and pointed at
 * the referral link — which is /r/CODE, the SHOPPER redirect. Tapping their own
 * dashboard button 302'd the ambassador to /products, set the referral cookie
 * in their own browser and recorded a partner_clicks row against their own
 * code. The message carried no portal URL at all, unlike the approval and
 * payout emails, so there was nothing else to tap either.
 *
 * Keep the parameter list free of comments: templates-sweep.test.ts derives its
 * fixture by parsing this signature's text, and a comment inside the braces
 * hides the fields after it.
 */
export function referralCodeAssignedTemplate(input: {
  name: string;
  referralCode: string;
  referralLink: string;
  commissionPercent: number;
  dashboardUrl: string;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Your Vanta Labs Referral Code Is Ready",
    html: renderLayout({
      preheader: `Your referral code: ${input.referralCode}`,
      titleHtml: `${name}, your referral code is ready`,
      bodyHtml: `
        <p>Your referral code: <strong>${escapeHtml(input.referralCode)}</strong></p>
        <p>You'll earn ${input.commissionPercent}% commission on qualifying orders placed through your link.</p>
        <p>Share this link — it's the one that credits you:</p>
        <p style="font-size:12px;color:#a1a1aa;word-break:break-all;">${escapeHtml(input.referralLink)}</p>
      `,
      // A real button, not the inline link this used to carry. An ambassador
      // has to be able to grab this on a phone in one tap; an underlined URL in
      // a paragraph is the shape recipients skim past, and the shape a spam
      // filter strips.
      ctaLabel: "Open my dashboard",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      `Your referral code: ${input.referralCode}`,
      `Your referral link (share this one): ${input.referralLink}`,
      `Commission rate: ${input.commissionPercent}%`,
      "",
      `Your dashboard: ${input.dashboardUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

// ---------------------------------------------------------------------
// Membership billing lifecycle. Trial-confirmation/remainder/renewal
// receipts and the payment-failed notice are transactional (billing
// disclosures/receipts) - sent via sendEmail() directly, never suppressed.
// Welcome/monthly-benefits/birthday/win-back are marketing - sent via
// sendMarketingEmail() (src/lib/email/marketing.ts), which appends the
// required unsubscribe footer automatically.
// ---------------------------------------------------------------------

export function membershipWelcomeTemplate(input: { name: string; tierName: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Welcome to ${input.tierName}`,
    html: renderLayout({
      preheader: `Welcome to ${input.tierName} at Vanta Labs.`,
      titleHtml: `Welcome, ${name}`,
      bodyHtml: `<p>You're now a <strong>${escapeHtml(input.tierName)}</strong> member. Faster point earning, member pricing, early access, and priority processing are active on your account starting now.</p>`,
    }),
    text: toText([`Welcome, ${input.name || "there"}.`, "", `You're now a ${input.tierName} member.`, "", "- Vanta Labs"]),
  };
}

// NOT WIRED UP YET. The four templates below (trial confirmation, monthly
// benefits, birthday, new product launch) have no send site anywhere in the
// app. They are kept because the features they belong to are half-built --
// /api/account/birthday already collects the date -- but nothing sends them
// today, so do not read their existence as evidence that a customer receives
// them.
//
// THEY ARE NOT ALL PROMOTIONAL, AND THIS USED TO SAY THEY WERE.
//
// The instruction here was "wire one through sendMarketingEmail() (they are all
// promotional)". Three of the four are. `membershipTrialConfirmationTemplate`
// is not: it states the exact amount charged today, the exact remainder and the
// date it lands, and the recurring price after that. It is the disclosure that
// makes the intro offer lawful, and its siblings —
// membershipRemainderReminderTemplate and membershipRenewalReminderTemplate,
// the same class of message — correctly go through sendEmail().
//
// Following the old instruction would have attached List-Unsubscribe to a
// billing disclosure and, worse, made it SUPPRESSIBLE: a member who once
// unsubscribed from marketing would have had the remainder taken from their
// card with no notice. So: the benefits, birthday and launch templates go
// through sendMarketingEmail(); the trial confirmation goes through sendEmail()
// like every other billing message.

export function membershipTrialConfirmationTemplate(input: {
  name: string;
  tierName: string;
  introChargeCents: number;
  remainderCents: number;
  remainderChargeDate: string;
  monthlyPriceCents: number;
}): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Your ${input.tierName} billing schedule`,
    html: renderLayout({
      preheader: "Your exact intro billing schedule.",
      titleHtml: `${name}, here's your exact billing schedule`,
      bodyHtml: `
        <p>You were charged <strong>${money(input.introChargeCents / 100)}</strong> today for your 7-day introductory period of ${escapeHtml(input.tierName)}.</p>
        <p>On <strong>${escapeHtml(input.remainderChargeDate)}</strong>, you'll be charged the remaining balance of your first month: <strong>${money(input.remainderCents / 100)}</strong>.</p>
        <p>After that, your membership renews automatically at <strong>${money(input.monthlyPriceCents / 100)}/month</strong> until you cancel. You can cancel anytime from your account dashboard, before your next renewal date, and keep access through the end of the period you already paid for.</p>
      `,
    }),
    text: toText([
      `${input.name || "there"}, here's your exact billing schedule.`,
      "",
      `Today: charged ${money(input.introChargeCents / 100)} for your 7-day intro period.`,
      `${input.remainderChargeDate}: remaining first-month balance of ${money(input.remainderCents / 100)} charged.`,
      `Then: ${money(input.monthlyPriceCents / 100)}/month automatically until canceled.`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function membershipRemainderReminderTemplate(input: { name: string; remainderCents: number; chargeDate: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Your first-month balance is charged in 3 days",
    html: renderLayout({
      preheader: `${money(input.remainderCents / 100)} will be charged on ${input.chargeDate}.`,
      titleHtml: `${name}, a reminder about your upcoming charge`,
      bodyHtml: `<p>In 3 days (${escapeHtml(input.chargeDate)}), we'll charge the remaining balance of your first month's membership: <strong>${money(input.remainderCents / 100)}</strong>.</p><p>No action is needed - this completes the 7-day intro offer you signed up for.</p>`,
    }),
    text: toText([`${input.name || "there"}, a reminder about your upcoming charge.`, "", `${input.chargeDate}: ${money(input.remainderCents / 100)} will be charged.`, "", "- Vanta Labs"]),
  };
}

export function membershipRemainderReceiptTemplate(input: { name: string; remainderCents: number; nextBillingDate: string; monthlyPriceCents: number }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Receipt: ${money(input.remainderCents / 100)} — first-month membership balance`,
    html: renderLayout({
      preheader: "Your first-month balance was charged successfully.",
      titleHtml: `${name}, your payment was successful`,
      bodyHtml: `<p>We charged <strong>${money(input.remainderCents / 100)}</strong> to complete your first month's membership.</p><p>Your next charge of <strong>${money(input.monthlyPriceCents / 100)}</strong> is scheduled for <strong>${escapeHtml(input.nextBillingDate)}</strong>.</p>`,
    }),
    text: toText([`${input.name || "there"}, your payment was successful.`, "", `Charged: ${money(input.remainderCents / 100)}`, `Next charge: ${money(input.monthlyPriceCents / 100)} on ${input.nextBillingDate}`, "", "- Vanta Labs"]),
  };
}

export function membershipRenewalReminderTemplate(input: { name: string; monthlyPriceCents: number; chargeDate: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Your membership renews in 3 days",
    html: renderLayout({
      preheader: `${money(input.monthlyPriceCents / 100)} will be charged on ${input.chargeDate}.`,
      titleHtml: `${name}, your renewal is coming up`,
      bodyHtml: `<p>In 3 days (${escapeHtml(input.chargeDate)}), your membership renews at <strong>${money(input.monthlyPriceCents / 100)}</strong>.</p><p>Want to make a change? You can cancel anytime before your renewal date from your account dashboard.</p>`,
    }),
    text: toText([`${input.name || "there"}, your renewal is coming up.`, "", `${input.chargeDate}: ${money(input.monthlyPriceCents / 100)} will be charged.`, "", "- Vanta Labs"]),
  };
}

// A RECEIPT HAS TO SAY WHAT IT IS A RECEIPT FOR.
//
// The subject was `Receipt: $29.00 charged` — a sum of money and nothing else.
// No product, no reason, nothing tying it to a membership the customer chose.
// That is a problem twice over.
//
// For the customer, it is the one email they open BECAUSE a charge appeared on
// their statement, and it answers the only question they have ("what was this
// for?") nowhere in the line they can see without opening it.
//
// For deliverability, a bare amount with no context is a spam signal, and this
// repo has already been burned by exactly that: a confirmation email was filed
// as spam and had its links stripped, which is the incident this whole pass
// began from. The sibling signup receipt directly below already names the tier
// — these two were simply never brought in line with it.
//
// `tierName` is optional because the Veyra webhook lane holds only a tier_id
// and resolving the name there would cost a query on the hot path; without it
// the subject still says "membership renewal", which is the part that matters.
export function membershipRenewalReceiptTemplate(input: { name: string; monthlyPriceCents: number; nextBillingDate: string; tierName?: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  const what = input.tierName ? `${input.tierName} membership renewal` : "membership renewal";
  return {
    subject: `Receipt: ${money(input.monthlyPriceCents / 100)} — ${what}`,
    html: renderLayout({
      preheader: "Your membership renewal was successful.",
      titleHtml: `${name}, your renewal was successful`,
      bodyHtml: `<p>We charged <strong>${money(input.monthlyPriceCents / 100)}</strong> for this month's membership.</p><p>Your next renewal is scheduled for <strong>${escapeHtml(input.nextBillingDate)}</strong>.</p>`,
    }),
    text: toText([`${input.name || "there"}, your renewal was successful.`, "", `Charged: ${money(input.monthlyPriceCents / 100)}`, `Next renewal: ${input.nextBillingDate}`, "", "- Vanta Labs"]),
  };
}

// Transactional receipt for the initial full-period charge on signup (annual
// pass, or a monthly tier with no $1 intro). Always sent (never suppressible)
// so the customer has a record of exactly what they paid.
export function membershipSignupReceiptTemplate(input: {
  name: string;
  tierName: string;
  amountCents: number;
  billingCycle: "monthly" | "annual";
  nextBillingDate: string;
  autoRenews: boolean;
}): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  const cycleLabel = input.billingCycle === "annual" ? "annual" : "monthly";
  const renewLine = input.autoRenews
    ? `<p>Your membership renews on <strong>${escapeHtml(input.nextBillingDate)}</strong>.</p>`
    : `<p>This is a one-time ${cycleLabel} pass — it does <strong>not</strong> auto-renew. Your access runs through <strong>${escapeHtml(input.nextBillingDate)}</strong>.</p>`;
  const renewTextLine = input.autoRenews
    ? `Renews: ${input.nextBillingDate}`
    : `One-time ${cycleLabel} pass (no auto-renew). Access through: ${input.nextBillingDate}`;
  return {
    subject: `Receipt: ${money(input.amountCents / 100)} — ${input.tierName} membership`,
    html: renderLayout({
      preheader: `Your ${input.tierName} membership is active.`,
      titleHtml: `${name}, welcome to ${escapeHtml(input.tierName)}`,
      bodyHtml: `<p>We charged <strong>${money(input.amountCents / 100)}</strong> for your ${escapeHtml(cycleLabel)} <strong>${escapeHtml(input.tierName)}</strong> membership.</p>${renewLine}<p style="margin:14px 0 0;font-size:12px;color:#a1a1aa;">Your member perks are active now and tied to your account.</p>`,
    }),
    text: toText([
      `${input.name || "there"}, welcome to ${input.tierName}.`,
      "",
      `Charged: ${money(input.amountCents / 100)} (${cycleLabel} ${input.tierName} membership)`,
      renewTextLine,
      "",
      "Your member perks are active now and tied to your account.",
      "",
      "- Vanta Labs",
    ]),
  };
}

export function membershipPaymentFailedTemplate(input: { name: string; amountCents: number; updatePaymentUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Action needed: your payment didn't go through",
    html: renderLayout({
      preheader: "Update your payment method to keep your membership active.",
      titleHtml: `${name}, we couldn't process your payment`,
      bodyHtml: `<p>We attempted to charge <strong>${money(input.amountCents / 100)}</strong> and it didn't go through. Update your payment method to keep your membership active.</p>`,
      ctaLabel: "Update Payment Method",
      ctaUrl: input.updatePaymentUrl,
    }),
    text: toText([`${input.name || "there"}, we couldn't process your payment.`, "", `Amount: ${money(input.amountCents / 100)}`, `Update your payment method: ${input.updatePaymentUrl}`, "", "- Vanta Labs"]),
  };
}

// `bodyHtml` is the ONE deliberate raw-HTML channel here: this is the monthly
// benefits mailer, whose body is composed in admin. `headline` is not — it is
// plain text that happened to be interpolated into the heading unescaped, so an
// ampersand in it rendered as markup rather than as an ampersand.
export function membershipBenefitsMonthlyTemplate(input: { name: string; headline: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: input.headline,
    html: renderLayout({
      preheader: input.headline,
      titleHtml: `${name}, ${escapeHtml(input.headline)}`,
      bodyHtml: input.bodyHtml,
      ctaLabel: input.ctaLabel,
      ctaUrl: input.ctaUrl,
      ctaVariant: "primary",
    }),
    text: toText([`${input.name || "there"}, ${input.headline}`, "", input.ctaUrl ?? null, "", "- Vanta Labs"]),
  };
}

export function membershipBirthdayTemplate(input: { name: string; bonusPoints: number; rewardUrl?: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Happy birthday from Vanta Labs",
    html: renderLayout({
      preheader: `A birthday gift of ${input.bonusPoints} points is in your account.`,
      titleHtml: `Happy birthday, ${name}!`,
      bodyHtml: `<p>We've added <strong>${input.bonusPoints} bonus points</strong> to your account as a birthday gift.</p>`,
      ctaLabel: input.rewardUrl ? "Use my reward" : undefined,
      ctaUrl: input.rewardUrl,
      ctaVariant: "primary",
    }),
    text: toText([`Happy birthday, ${input.name || "there"}!`, "", `${input.bonusPoints} bonus points have been added to your account.`, input.rewardUrl ? `Spend them here: ${input.rewardUrl}` : null, "", "- Vanta Labs"]),
  };
}

export function membershipWinBackTemplate(input: { name: string; tierName: string; offerPercent: number; resubscribeUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "We'd love to have you back",
    html: renderLayout({
      preheader: `${input.offerPercent}% off if you rejoin ${input.tierName}.`,
      titleHtml: `${name}, come back to ${escapeHtml(input.tierName)}`,
      bodyHtml: `<p>Your membership was canceled. As a thank-you for being a member, here's <strong>${input.offerPercent}% off</strong> your first month if you rejoin.</p>`,
      ctaLabel: "Rejoin",
      ctaUrl: input.resubscribeUrl,
      ctaVariant: "primary",
    }),
    text: toText([`${input.name || "there"}, come back to ${input.tierName}.`, "", `${input.offerPercent}% off your first month: ${input.resubscribeUrl}`, "", "- Vanta Labs"]),
  };
}

export function newProductLaunchTemplate(input: { name: string; productName: string; productUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Early access: ${input.productName}`,
    html: renderLayout({
      preheader: `${input.productName} is available to members before public launch.`,
      titleHtml: `${name}, you have early access to ${escapeHtml(input.productName)}`,
      bodyHtml: `<p>As a member, you can shop <strong>${escapeHtml(input.productName)}</strong> before it's available to the public.</p>`,
      ctaLabel: "Shop Now",
      ctaUrl: input.productUrl,
      ctaVariant: "primary",
    }),
    text: toText([`${input.name || "there"}, you have early access to ${input.productName}.`, "", input.productUrl, "", "- Vanta Labs"]),
  };
}

export function backInStockTemplate(input: { name: string; productName: string; productUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Back in stock: ${input.productName}`,
    html: renderLayout({
      preheader: `${input.productName} is back in stock.`,
      titleHtml: `${name}, ${escapeHtml(input.productName)} is back`,
      bodyHtml: `<p><strong>${escapeHtml(input.productName)}</strong> is back in stock.</p>`,
      ctaLabel: "Shop Now",
      ctaUrl: input.productUrl,
      ctaVariant: "primary",
    }),
    text: toText([`${input.name || "there"}, ${input.productName} is back in stock.`, "", input.productUrl, "", "- Vanta Labs"]),
  };
}

// ---------------------------------------------------------------------
// Abandoned cart recovery sequence. All marketing-class (sent via
// sendMarketingEmail()).
//
// THE SEQUENCE HAS A SHAPE, AND EACH MESSAGE HAS ONE JOB.
//
//   1 h   "we kept it" — the plain reminder, nothing to argue with
//   24 h  "what you might want to know" — testing, shipping, a person to ask
//   72 h  "the last note" — closes the loop, carries the discount if allowed
//
// The copy says what is true and nothing more. There is no countdown the
// database will not enforce, no "hurry", no shouting: this store sells to
// researchers who read the COA before the price, and the message that earns
// their order is the one that reads like it was written by someone who knows
// that. Every subject passes checkSubjectLine and findTriggerPhrases in
// deliverability-check.ts — template-standards.test.ts holds them there.
// ---------------------------------------------------------------------

function cartItemsHtml(items: Array<{ name: string; quantity: number }>) {
  return items.map((item) => `<tr><td style="padding:4px 0;color:#e4e4e7;">${escapeHtml(item.name)} × ${item.quantity}</td></tr>`).join("");
}

function cartSummaryHtml(items: Array<{ name: string; quantity: number }>, cartValueCents: number) {
  return `<table role="presentation" width="100%" style="margin-top:8px;font-size:14px;">${cartItemsHtml(items)}</table>`
    + `<p style="margin-top:12px;">Cart total: <strong style="color:#ffffff;">${money(cartValueCents / 100)}</strong></p>`;
}

function cartSummaryText(items: Array<{ name: string; quantity: number }>, cartValueCents: number): string[] {
  return [...items.map((i) => `${i.name} x ${i.quantity}`), "", `Cart total: ${money(cartValueCents / 100)}`];
}

/** "Hi Sam," when a name is known; nothing when it is not. Never "Hi there". */
function greeting(name: string): { html: string; text: string | null } {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first
    ? { html: `<p style="margin:0 0 12px;">Hi ${escapeHtml(first)},</p>`, text: `Hi ${first},` }
    : { html: "", text: null };
}

export function cartRecoveryT30mTemplate(input: { name: string; items: Array<{ name: string; quantity: number }>; cartValueCents: number; restoreUrl: string }): EmailTemplate {
  const hi = greeting(input.name);
  return {
    subject: "We kept your cart",
    html: renderLayout({
      preheader: "Everything you selected is still here, at the price you saw.",
      titleHtml: "Your selection is saved",
      bodyHtml: `${hi.html}<p style="margin:0 0 4px;">You left these in your cart. We have held them for you, at the same price.</p>${cartSummaryHtml(input.items, input.cartValueCents)}<p style="margin-top:14px;color:#a1a1aa;">Pick up where you left off whenever you are ready.</p>`,
      ctaLabel: "Return to my cart",
      ctaUrl: input.restoreUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      hi.text,
      hi.text ? "" : null,
      "You left these in your cart. We have held them for you, at the same price.",
      "",
      ...cartSummaryText(input.items, input.cartValueCents),
      "",
      `Return to your cart: ${input.restoreUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function cartRecoveryT12hTemplate(input: { name: string; items: Array<{ name: string; quantity: number }>; cartValueCents: number; restoreUrl: string }): EmailTemplate {
  const hi = greeting(input.name);
  return {
    subject: "Your cart is still saved",
    html: renderLayout({
      preheader: "A quick note: your selection is held and ready whenever you are.",
      titleHtml: "Still here when you are",
      bodyHtml: `${hi.html}<p style="margin:0 0 4px;">A quick note that your cart is still saved.</p>${cartSummaryHtml(input.items, input.cartValueCents)}`,
      ctaLabel: "Return to my cart",
      ctaUrl: input.restoreUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      hi.text,
      hi.text ? "" : null,
      "A quick note that your cart is still saved.",
      "",
      ...cartSummaryText(input.items, input.cartValueCents),
      "",
      `Return to your cart: ${input.restoreUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * The second message carries no discount, and that is the point of it.
 *
 * Someone who has not finished checking out a research compound after a day
 * is usually weighing something — is the batch tested, will it arrive intact,
 * is there a person behind the site. Answering those is worth more than five
 * percent to the people who were hesitating and costs nothing for the people
 * who were merely busy. Every claim below is one the site already makes:
 * per-batch COAs in the COA library, tracked shipping, a monitored support
 * address in the footer of every message.
 */
export function cartRecoveryT24hTemplate(input: { name: string; items: Array<{ name: string; quantity: number }>; cartValueCents: number; restoreUrl: string }): EmailTemplate {
  const hi = greeting(input.name);
  const points = [
    ["Tested per batch", "Every batch is third-party tested and its certificate of analysis is available before you order."],
    ["Tracked, discreet shipping", "Orders ship with tracking in plain packaging, and you get an email at every step."],
    ["A person to ask", "Reply to this email or write to support and a member of the team answers — no ticket maze."],
  ];
  const pointsHtml = points
    .map(([title, body]) => `<tr><td style="padding:8px 0;border-top:1px solid rgba(255,255,255,0.08);"><strong style="color:#ffffff;">${escapeHtml(title)}</strong><br/><span style="color:#d4d4d4;">${escapeHtml(body)}</span></td></tr>`)
    .join("");
  return {
    subject: "Before you order: testing, shipping, support",
    html: renderLayout({
      preheader: "The three things most people want to know before their first order.",
      titleHtml: "A few things worth knowing",
      bodyHtml: `${hi.html}<p style="margin:0 0 4px;">Your cart is still saved. If you were weighing it up, these are the three questions we hear most.</p><table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">${pointsHtml}</table>${cartSummaryHtml(input.items, input.cartValueCents)}`,
      ctaLabel: "Finish checking out",
      ctaUrl: input.restoreUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      hi.text,
      hi.text ? "" : null,
      "Your cart is still saved. If you were weighing it up, these are the three questions we hear most.",
      "",
      ...points.map(([title, body]) => `${title}: ${body}`),
      "",
      ...cartSummaryText(input.items, input.cartValueCents),
      "",
      `Finish checking out: ${input.restoreUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

/**
 * The last message about this cart, with or without a code.
 *
 * `couponCode` empty means no discount was allowed for this shopper (see
 * recoveryDiscountAllowed in cart-recovery.ts); the email then says only that
 * it is the last note, which is true, and asks nothing else. When a code is
 * present, `discountPercent` and `expiresAt` describe the row the checkout will
 * honour — never a number computed here.
 */
export function cartRecoveryT72hTemplate(input: {
  name: string;
  items: Array<{ name: string; quantity: number }>;
  cartValueCents: number;
  restoreUrl: string;
  couponCode: string;
  discountPercent?: number;
  expiresAt: string;
}): EmailTemplate {
  const hi = greeting(input.name);
  const code = input.couponCode.trim();
  const percent = Math.max(0, Math.round(Number(input.discountPercent ?? 0)));
  const hasOffer = Boolean(code) && percent > 0;
  const closing = "This is the last note we will send about this cart.";
  const offerHtml = hasOffer
    ? `<p style="margin-top:14px;">If it is still useful, code <strong style="color:#ffffff;">${escapeHtml(code)}</strong> takes ${percent}% off this order${input.expiresAt ? ` through ${escapeHtml(input.expiresAt)}` : ""}.</p>`
    : "";
  return {
    subject: hasOffer ? `One last note on your cart, with ${percent}% off` : "One last note on your cart",
    html: renderLayout({
      preheader: hasOffer ? `Code ${code} takes ${percent}% off if you finish this order.` : "Your selection is still saved if you want it.",
      titleHtml: "One last note",
      bodyHtml: `${hi.html}<p style="margin:0 0 4px;">${closing} Your selection is still saved if you want it.</p>${cartSummaryHtml(input.items, input.cartValueCents)}${offerHtml}`,
      ctaLabel: "Finish my order",
      ctaUrl: input.restoreUrl,
      ctaVariant: "primary",
    }),
    text: toText([
      hi.text,
      hi.text ? "" : null,
      `${closing} Your selection is still saved if you want it.`,
      "",
      ...cartSummaryText(input.items, input.cartValueCents),
      hasOffer ? "" : null,
      hasOffer ? `Code ${code} takes ${percent}% off this order${input.expiresAt ? ` through ${input.expiresAt}` : ""}.` : null,
      "",
      `Finish your order: ${input.restoreUrl}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

export function contactFormNotificationTemplate(input: {
  firstName: string;
  lastName: string;
  email: string;
  orderNumber?: string;
  subject: string;
  message: string;
}): EmailTemplate {
  const lines = [
    `Name: ${input.firstName} ${input.lastName}`,
    `Email: ${input.email}`,
    input.orderNumber ? `Order Number: ${input.orderNumber}` : null,
    "",
    input.message,
  ].filter((line): line is string => line !== null);

  // Branded too. It goes to the owner rather than a customer, which lowers the
  // embarrassment but not the stakes: an unstyled wall of <p> is exactly what
  // gets filed as spam, and a contact-form notification in a spam folder is a
  // customer whose message nobody answers.
  return {
    subject: `Vanta Labs Contact Form - ${input.subject}`,
    html: renderLayout({
      preheader: `${input.firstName} ${input.lastName}: ${input.subject}`,
      titleHtml: "New contact form message",
      bodyHtml: lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "")).join(""),
    }),
    text: lines.join("\n"),
  };
}

// Sent to the customer who submitted the contact form, confirming we received
// their message. Transactional (a direct reply to their own action), so it is
// sent via sendEmail() and is not suppressible.
// DELIBERATELY DOES NOT QUOTE THE SUBMISSION. It used to render the subject
// and the full message under "Your message:", which turned an anonymous form
// into a relay: arbitrary text, branded and sent from the transactional
// identity, to any address typed into the form. The owner's copy
// (contactFormNotificationTemplate) still carries the message; the poster does
// not need it echoed to know it arrived.
export function contactFormAutoReplyTemplate(input: {
  firstName: string;
}): EmailTemplate {
  const firstName = escapeHtml(input.firstName || "there");

  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${firstName},</p>
    <p style="margin:0 0 14px;">Thanks for reaching out to Vanta Labs — we've received your message and a member of our team will get back to you within 1–2 business days.</p>
    <p style="margin:0;font-size:13px;color:#a1a1aa;">If you need to add anything, just reply to this email.</p>
  `;

  return {
    subject: `We received your message — Vanta Labs`,
    html: renderLayout({
      preheader: "Thanks for contacting Vanta Labs. We'll be in touch within 1–2 business days.",
      titleHtml: "We got your message",
      bodyHtml,
    }),
    text: toText([
      `Hi ${input.firstName || "there"},`,
      "",
      "Thanks for reaching out to Vanta Labs — we've received your message and will get back to you within 1–2 business days.",
      "",
      "If you need to add anything, just reply to this email.",
      "",
      "Vanta Labs · Research Use Only",
    ]),
  };
}

// Sent to the business when a wholesale enquiry is submitted. Every value the
// visitor supplied is escaped before it reaches the HTML body — this is an
// email an owner opens, and an unescaped message field is a script-injection
// vector aimed straight at them.
export function wholesaleInquiryNotificationTemplate(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  organization?: string;
  volume?: string;
  products?: string;
  message: string;
}): EmailTemplate {
  const lines = [
    `Name: ${input.firstName} ${input.lastName}`,
    `Email: ${input.email}`,
    input.phone ? `Phone: ${input.phone}` : null,
    input.organization ? `Organisation: ${input.organization}` : null,
    input.volume ? `Estimated volume: ${input.volume}` : null,
    input.products ? `Products of interest: ${input.products}` : null,
    "",
    input.message,
  ].filter((line): line is string => line !== null);

  return {
    // Named so it is unmistakable in an inbox and filterable away from orders.
    subject: `Wholesale inquiry — ${input.firstName} ${input.lastName}`,
    html: renderLayout({
      preheader: `${input.firstName} ${input.lastName} — wholesale`,
      titleHtml: "New wholesale inquiry",
      bodyHtml: lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "")).join(""),
    }),
    text: lines.join("\n"),
  };
}

// Confirms receipt to the person who enquired. Deliberately promises nothing
// about timing: no response-time commitment is configured anywhere in this
// system, and inventing one here would be a promise the business never made.
export function wholesaleInquiryAutoReplyTemplate(input: { firstName: string }): EmailTemplate {
  // BRANDED, like every other customer-facing message. It used to be three
  // escaped <p> tags and nothing else — the same bare shape Gmail filed as
  // spam on 2026-08-29 — sent to a prospective wholesale buyer, which is about
  // the worst audience to look untrustworthy in front of.
  const name = escapeHtml(input.firstName);
  return {
    subject: "Wholesale Request Received — Vanta Labs",
    html: renderLayout({
      preheader: "We've got your wholesale inquiry.",
      titleHtml: name ? `Thanks, ${name}` : "Thanks for getting in touch",
      bodyHtml:
        `<p>We've received your wholesale inquiry and will review the information you submitted.</p>`
        + `<p>If anything changes in the meantime, just reply to this email.</p>`,
    }),
    text: toText([
      input.firstName ? `Hi ${input.firstName},` : "Hello,",
      "",
      "We've received your wholesale inquiry and will review the information you submitted.",
      "If anything changes in the meantime, just reply to this email.",
      "",
      "- Vanta Labs",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Generic campaign template.
//
// One reusable branded message driven entirely by admin input, rather than a
// hand-built template per promotion. The admin supplies a headline, some body
// copy, an optional promo code and a call to action; everything else — brand
// header, dark styling, button, footer, postal address — is applied here, so a
// campaign takes under a minute to compose and can't drift off-brand.
//
// BODY COPY IS PLAIN TEXT, NOT HTML, and that is a security decision as much as
// a usability one. Accepting HTML from the composer would put arbitrary markup
// into mail sent to every customer on the list; instead the text is escaped and
// blank-line-separated paragraphs are turned into <p> elements. An operator
// gets paragraphs, which is what they actually need, and nothing else is
// reachable from the compose box.
// ---------------------------------------------------------------------------
/**
 * A marketing campaign, composed by an operator in the admin.
 *
 * `postalAddress` is the CAN-SPAM postal address and the sender refuses to send
 * without one.
 *
 * Keep the parameter list free of comments: templates-sweep.test.ts derives its
 * fixture by parsing this signature's text, and a comment inside the braces
 * hides every field after it — which is why this template had been swept for
 * months with no postal address in it at all.
 */
export function campaignTemplate(input: {
  subject: string;
  previewText?: string | null;
  headline: string;
  body: string;
  promoCode?: string | null;
  ctaLabel: string;
  ctaUrl: string;
  offerTerms?: string | null;
  postalAddress: string;
}): EmailTemplate {
  // offerTerms: the terms of a one-time gift riding on this message — minimum,
  // deadline, one per customer — written by the sweep from the offer catalogue,
  // never by the operator. Rendered under the copy so the email states exactly
  // what the checkout will honour, whatever the copy above it says. (Documented
  // here rather than in the signature: templates-sweep.test.ts parses the
  // signature text and a comment inside the braces hides the fields after it.)
  // Coerced rather than trusted. Every other template here is called from one
  // known site with a typed object; this one is driven by a database row an
  // operator edits, so a null that slipped past a migration default should
  // render an empty line, not throw partway through a send.
  const bodyText = String(input.body ?? "");
  const postalAddress = String(input.postalAddress ?? "");
  const offerTerms = String(input.offerTerms ?? "").trim();
  const offerTermsHtml = offerTerms
    ? `<p style="margin:16px 0 0;padding:12px 14px;border:1px solid rgba(255,255,255,0.14);border-radius:12px;font-size:13px;line-height:1.5;color:#d4d4d8;">${escapeHtml(offerTerms)}</p>`
    : "";

  const paragraphs = bodyText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    // Single newlines inside a paragraph become <br/>, so a short list typed in
    // the composer survives instead of collapsing onto one line.
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const code = input.promoCode?.trim();
  const codeBlock = code
    ? `<div style="margin:18px 0 4px;padding:14px;border:1px dashed rgba(255,255,255,0.35);border-radius:12px;text-align:center;"><span style="font-size:20px;font-weight:800;letter-spacing:0.14em;color:#ffffff;">${escapeHtml(code)}</span></div>`
    : "";

  // The address is escaped and rendered as plain text; newlines become <br/> so
  // a multi-line address stays readable.
  const footerNoteHtml = `<p style="margin:12px 0 0;font-size:11px;color:#71717a;">${escapeHtml(postalAddress).replace(/\n/g, "<br/>")}</p>`;

  const preheader = input.previewText?.trim() || input.headline;

  const html = renderLayout({
    preheader,
    titleHtml: escapeHtml(input.headline),
    bodyHtml: `${paragraphs}${codeBlock}${offerTermsHtml}`,
    ctaLabel: input.ctaLabel,
    ctaUrl: input.ctaUrl,
    ctaVariant: "primary",
    footerNoteHtml,
  });

  const text = toText([
    input.headline,
    "",
    bodyText.trim(),
    code ? "" : null,
    code ? `Code: ${code}` : null,
    offerTerms ? "" : null,
    offerTerms || null,
    "",
    `${input.ctaLabel}: ${input.ctaUrl}`,
    "",
    postalAddress,
  ]);

  return { subject: input.subject, html, text };
}
