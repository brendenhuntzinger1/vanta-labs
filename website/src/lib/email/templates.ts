import type { EmailTemplate } from "@/lib/email/types";
import { formatDisplayDate } from "@/lib/format-date";

function escapeHtml(value: string) {
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
function renderLayout(input: { preheader: string; titleHtml: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }) {
  const cta = input.ctaUrl && input.ctaLabel
    ? `<tr><td style="padding:28px 0 4px;"><a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#f4f4f4;color:#111111;text-decoration:none;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-size:13px;padding:12px 24px;border-radius:999px;">${escapeHtml(input.ctaLabel)}</a></td></tr>`
    : "";

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
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
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function toText(lines: Array<string | null | false | undefined>) {
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

export function emailVerificationTemplate(input: { name: string; verifyUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Verify your Vanta Labs account",
    html: renderLayout({
      preheader: "Confirm your email to activate your account.",
      titleHtml: `Hi ${name}, please verify your email`,
      bodyHtml: `<p>Click below to confirm your email address and activate your account.</p><p>If you didn't create this account, you can safely ignore this email.</p>`,
      ctaLabel: "Verify Email",
      ctaUrl: input.verifyUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Confirm your email address to activate your account:",
      input.verifyUrl,
      "",
      "If you didn't create this account, you can safely ignore this email.",
      "",
      "- Vanta Labs",
    ]),
  };
}

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
  const savings = Math.max(0, residual);
  const addOn = Math.max(0, -residual);
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
          ${savings > 0 ? summaryRow("Discounts &amp; credits", `-${money(savings)}`) : ""}
          ${tax > 0 ? summaryRow("Sales tax", money(tax)) : ""}
          ${cardFee > 0 ? summaryRow("Card processing fee", money(cardFee)) : ""}
          ${addOn > 0 ? summaryRow("Shipping protection", money(addOn)) : ""}
          ${summaryRow("Total", money(input.total), { bold: true })}
        </table>
      `,
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
      savings > 0 ? `Discounts & credits: -${money(savings)}` : null,
      tax > 0 ? `Sales tax: ${money(tax)}` : null,
      cardFee > 0 ? `Card processing fee: ${money(cardFee)}` : null,
      addOn > 0 ? `Shipping protection: ${money(addOn)}` : null,
      `Total: ${money(input.total)}`,
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
    }),
    text: [
      `Hi ${input.customerName || "there"},`,
      ``,
      `We're sorry your order ${input.originalOrderNumber} didn't arrive in perfect condition.`,
      `A replacement (${input.replacementOrderNumber}) is being prepared and shipped at no charge:`,
      ...input.items.map((item) => `  - ${item.name} × ${Math.max(1, Math.floor(item.quantity))}`),
      ``,
      `You'll receive tracking as soon as it ships. Nothing is charged.`,
    ].join("\n"),
  };
}

export function deliveryConfirmationTemplate(input: {
  customerName: string;
  orderId: string;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  return {
    subject: `Delivered — order ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} has been delivered.`,
      titleHtml: `${name}, your order was delivered`,
      bodyHtml: `<p>Order <strong>${escapeHtml(input.orderId)}</strong> has been marked <strong>delivered</strong>. We hope everything arrived in great shape.</p><p>If anything's not right, just reply to this email and we'll help.</p>`,
    }),
    text: toText([
      `${input.customerName || "there"}, your order was delivered.`,
      "",
      `Order ${input.orderId} has been marked delivered.`,
      "If anything's not right, reply to this email and we'll help.",
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

export function ambassadorApprovedTemplate(input: {
  name: string;
  referralCode?: string;
  dashboardUrl: string;
  commissionPercent?: number;
  personalDiscountPercent?: number;
  referralDiscountPercent?: number;
  holdDays?: number;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  const code = input.referralCode ? escapeHtml(input.referralCode) : null;
  const commissionPct = Number.isFinite(input.commissionPercent) ? Number(input.commissionPercent) : 10;
  const personalPct = Number.isFinite(input.personalDiscountPercent) ? Number(input.personalDiscountPercent) : 15;
  const referralPct = Number.isFinite(input.referralDiscountPercent) ? Number(input.referralDiscountPercent) : 10;
  const holdDays = Number.isFinite(input.holdDays) ? Number(input.holdDays) : 14;

  const bodyHtml = `
    <p>Congratulations, ${name} — your application to the Vanta Labs Ambassador Program has been <strong>approved</strong>. Welcome aboard.</p>
    ${code ? `<p><strong>Your referral code:</strong> ${code} — customers who use it get <strong>${referralPct}% off</strong>.</p>` : ""}
    <p><strong>Your personal discount:</strong> as an approved ambassador you automatically get <strong>${personalPct}% off your own purchases</strong> — just sign in and check out; it applies at the cart, no code needed.</p>

    <p style="margin-top:20px"><strong>Starting Benefits</strong></p>
    <ul>
      <li><strong>${commissionPct}% commission</strong> on every completed referral.</li>
      <li><strong>${personalPct}% personal discount</strong> on all Vanta Labs products.</li>
      <li>Access to exclusive promotions, giveaways, and future ambassador perks.</li>
    </ul>

    <p style="margin-top:16px"><strong>Growth Opportunities</strong></p>
    <p>As your referrals begin to grow and you consistently bring in completed orders, we'll review your performance and negotiate a higher commission rate. We want to reward ambassadors who genuinely help grow Vanta Labs, so there is no fixed ceiling on what top performers can earn.</p>
    <p>High-performing ambassadors may receive:</p>
    <ul>
      <li>Increased commission percentages</li>
      <li>Cash bonuses</li>
      <li>Free products</li>
      <li>Early access to new releases</li>
      <li>Exclusive promotions</li>
      <li>Long-term partnership opportunities</li>
    </ul>

    <p style="margin-top:16px"><strong>Monthly Performance</strong></p>
    <p>Referral performance is reviewed each month based on completed, paid orders. Refunded, canceled, fraudulent, or chargeback orders do not count toward referral totals.</p>
    <p>Our goal is simple: the more value you bring to Vanta Labs, the more we'll invest back into you.</p>

    <p style="margin-top:16px"><strong>How commissions work</strong></p>
    <p>You earn ${commissionPct}% on the merchandise total of each completed order placed with your code. A commission is <em>pending</em> for ${holdDays} days after the order completes (this protects against refunds and chargebacks), then becomes <em>approved</em> and is included in the next payout. Payouts run every two weeks. You'll never be paid on a refunded or cancelled order.</p>
    <p>Track everything — pending, approved, and paid commissions plus your referral orders — anytime from your dashboard.</p>

    <p style="margin-top:16px"><strong>Getting paid</strong></p>
    <p>We pay via <strong>PayPal, Venmo, or Cash App</strong>. Open your dashboard to choose your payout method and enter your handle so we can pay you on the next cycle.</p>
  `;

  return {
    subject: "You're approved — welcome to the Vanta Labs Ambassador Program",
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
      `Personal discount: ${personalPct}% off your own purchases while approved (auto-applied at checkout when signed in).`,
      "",
      "Benefits:",
      `- ${personalPct}% off your own purchases`,
      `- Referral code giving your audience ${referralPct}% off`,
      `- ${commissionPct}% commission on completed orders with your code`,
      "- Real-time dashboard (pending/approved/paid commissions, referral orders, earnings)",
      "- Payouts every two weeks",
      "- Performance bonuses and higher commission potential",
      "- Early access to new products and promotions",
      "",
      "Responsibilities:",
      "- At least 3 social posts per month",
      "- Represent Vanta Labs professionally",
      "- No medical / human-use claims",
      "- No prohibited advertising",
      "- Keep your code active",
      "- Follow all program rules",
      "",
      `How commissions work: you earn ${commissionPct}% on each completed order's merchandise total. A commission is pending for ${holdDays} days after completion (protects against refunds/chargebacks), then approved and paid in the next biweekly payout. Refunded/cancelled orders never pay.`,
      "",
      "Getting paid: we pay via PayPal, Venmo, or Cash App — set your payout method in your dashboard.",
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

export function referralCodeAssignedTemplate(input: {
  name: string;
  referralCode: string;
  referralLink: string;
  commissionPercent: number;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Your Vanta Labs Referral Code Is Ready",
    html: renderLayout({
      preheader: `Your referral code: ${input.referralCode}`,
      titleHtml: `${name}, your referral code is ready`,
      bodyHtml: `
        <p>Your referral code: <strong>${escapeHtml(input.referralCode)}</strong></p>
        <p>Your referral link: <a href="${escapeHtml(input.referralLink)}" style="color:#f2c94c;">${escapeHtml(input.referralLink)}</a></p>
        <p>You'll earn ${input.commissionPercent}% commission on qualifying orders placed through your link.</p>
      `,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      `Your referral code: ${input.referralCode}`,
      `Your referral link: ${input.referralLink}`,
      `Commission rate: ${input.commissionPercent}%`,
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
    subject: `Receipt: ${money(input.remainderCents / 100)} charged`,
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

export function membershipRenewalReceiptTemplate(input: { name: string; monthlyPriceCents: number; nextBillingDate: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: `Receipt: ${money(input.monthlyPriceCents / 100)} charged`,
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
    }),
    text: toText([`${input.name || "there"}, ${input.headline}`, "", input.ctaUrl ?? null, "", "- Vanta Labs"]),
  };
}

export function membershipBirthdayTemplate(input: { name: string; bonusPoints: number }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Happy birthday from Vanta Labs",
    html: renderLayout({
      preheader: `A birthday gift of ${input.bonusPoints} points is in your account.`,
      titleHtml: `Happy birthday, ${name}!`,
      bodyHtml: `<p>We've added <strong>${input.bonusPoints} bonus points</strong> to your account as a birthday gift.</p>`,
    }),
    text: toText([`Happy birthday, ${input.name || "there"}!`, "", `${input.bonusPoints} bonus points have been added to your account.`, "", "- Vanta Labs"]),
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
    }),
    text: toText([`${input.name || "there"}, ${input.productName} is back in stock.`, "", input.productUrl, "", "- Vanta Labs"]),
  };
}

// ---------------------------------------------------------------------
// Abandoned cart recovery sequence. All marketing-class (sent via
// sendMarketingEmail()).
// ---------------------------------------------------------------------

function cartItemsHtml(items: Array<{ name: string; quantity: number }>) {
  return items.map((item) => `<tr><td style="padding:4px 0;color:#e4e4e7;">${escapeHtml(item.name)} × ${item.quantity}</td></tr>`).join("");
}

export function cartRecoveryT30mTemplate(input: { name: string; items: Array<{ name: string; quantity: number }>; cartValueCents: number; restoreUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "You left something behind",
    html: renderLayout({
      preheader: "Your cart is saved and waiting for you.",
      titleHtml: `${name}, you left something behind`,
      bodyHtml: `<table role="presentation" width="100%" style="margin-top:8px;font-size:14px;">${cartItemsHtml(input.items)}</table><p style="margin-top:16px;">Cart total: <strong>${money(input.cartValueCents / 100)}</strong></p>`,
      ctaLabel: "Restore My Cart",
      ctaUrl: input.restoreUrl,
    }),
    text: toText([`${input.name || "there"}, you left something behind.`, "", ...input.items.map((i) => `${i.name} x ${i.quantity}`), "", `Total: ${money(input.cartValueCents / 100)}`, input.restoreUrl, "", "- Vanta Labs"]),
  };
}

export function cartRecoveryT12hTemplate(input: { name: string; items: Array<{ name: string; quantity: number }>; cartValueCents: number; restoreUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Your cart is still waiting for you",
    html: renderLayout({
      preheader: "Friendly reminder - your cart hasn't gone anywhere.",
      titleHtml: `${name}, your cart is still here`,
      bodyHtml: `<table role="presentation" width="100%" style="margin-top:8px;font-size:14px;">${cartItemsHtml(input.items)}</table><p style="margin-top:16px;">Cart total: <strong>${money(input.cartValueCents / 100)}</strong></p>`,
      ctaLabel: "Resume Checkout",
      ctaUrl: input.restoreUrl,
    }),
    text: toText([`${input.name || "there"}, your cart is still here.`, "", ...input.items.map((i) => `${i.name} x ${i.quantity}`), "", `Total: ${money(input.cartValueCents / 100)}`, input.restoreUrl, "", "- Vanta Labs"]),
  };
}

export function cartRecoveryT24hTemplate(input: {
  name: string;
  items: Array<{ name: string; quantity: number }>;
  cartValueCents: number;
  restoreUrl: string;
  couponCode: string;
  expiresAt: string;
}): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "5% off - your cart is waiting",
    html: renderLayout({
      preheader: `Use code ${input.couponCode} for 5% off.`,
      titleHtml: `${name}, here's 5% off to complete your order`,
      bodyHtml: `<table role="presentation" width="100%" style="margin-top:8px;font-size:14px;">${cartItemsHtml(input.items)}</table><p style="margin-top:16px;">Cart total: <strong>${money(input.cartValueCents / 100)}</strong></p><p>Use code <strong>${escapeHtml(input.couponCode)}</strong> for 5% off - expires ${escapeHtml(input.expiresAt)}.</p>`,
      ctaLabel: "Resume Checkout",
      ctaUrl: input.restoreUrl,
    }),
    text: toText([`${input.name || "there"}, here's 5% off to complete your order.`, "", `Code: ${input.couponCode} (expires ${input.expiresAt})`, "", ...input.items.map((i) => `${i.name} x ${i.quantity}`), "", `Total: ${money(input.cartValueCents / 100)}`, input.restoreUrl, "", "- Vanta Labs"]),
  };
}

export function cartRecoveryT72hTemplate(input: {
  name: string;
  items: Array<{ name: string; quantity: number }>;
  cartValueCents: number;
  restoreUrl: string;
  couponCode: string;
  expiresAt: string;
}): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: "Last chance - your cart expires soon",
    html: renderLayout({
      preheader: `Use code ${input.couponCode} before it expires.`,
      titleHtml: `${name}, last chance on your cart`,
      bodyHtml: `<table role="presentation" width="100%" style="margin-top:8px;font-size:14px;">${cartItemsHtml(input.items)}</table><p style="margin-top:16px;">Cart total: <strong>${money(input.cartValueCents / 100)}</strong></p><p>Use code <strong>${escapeHtml(input.couponCode)}</strong> for 5% off - expires ${escapeHtml(input.expiresAt)}.</p>`,
      ctaLabel: "Resume Checkout",
      ctaUrl: input.restoreUrl,
    }),
    text: toText([`${input.name || "there"}, last chance on your cart.`, "", `Code: ${input.couponCode} (expires ${input.expiresAt})`, "", ...input.items.map((i) => `${i.name} x ${i.quantity}`), "", `Total: ${money(input.cartValueCents / 100)}`, input.restoreUrl, "", "- Vanta Labs"]),
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

  return {
    subject: `Vanta Labs Contact Form - ${input.subject}`,
    html: lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br />")).join(""),
    text: lines.join("\n"),
  };
}

// Sent to the customer who submitted the contact form, confirming we received
// their message. Transactional (a direct reply to their own action), so it is
// sent via sendEmail() and is not suppressible.
export function contactFormAutoReplyTemplate(input: {
  firstName: string;
  subject: string;
  message: string;
}): EmailTemplate {
  const firstName = escapeHtml(input.firstName || "there");
  const subject = escapeHtml(input.subject);
  const quoted = escapeHtml(input.message).replace(/\n/g, "<br />");

  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${firstName},</p>
    <p style="margin:0 0 14px;">Thanks for reaching out to Vanta Labs — we've received your message and a member of our team will get back to you within 1–2 business days.</p>
    <p style="margin:0 0 6px;font-size:12px;color:#a1a1aa;">Your message:</p>
    <div style="margin:0 0 14px;padding:12px 14px;border-left:2px solid rgba(255,255,255,0.2);color:#d4d4d4;font-size:13px;">
      <strong>${subject}</strong><br />${quoted}
    </div>
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
      "Your message:",
      input.subject,
      input.message,
      "",
      "If you need to add anything, just reply to this email.",
      "",
      "Vanta Labs · Research Use Only",
    ]),
  };
}
