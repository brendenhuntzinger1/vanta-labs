import type { EmailTemplate } from "@/lib/email/types";

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

function renderLayout(input: { preheader: string; title: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }) {
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
          <h1 style="margin:0;font-size:22px;line-height:1.3;color:#ffffff;">${escapeHtml(input.title)}</h1>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;font-size:14px;line-height:1.7;color:#d4d4d4;">
          ${input.bodyHtml}
        </td></tr>
        ${cta}
        <tr><td style="padding:28px 32px 24px;border-top:1px solid rgba(255,255,255,0.1);margin-top:24px;">
          <p style="margin:20px 0 0;font-size:12px;color:#71717a;">Vanta Labs · Research Use Only<br/>Questions? <a href="mailto:brendenhuntzinger1@vantalabsresearch.com" style="color:#a1a1aa;">brendenhuntzinger1@vantalabsresearch.com</a></p>
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
  const expiryHuman = input.endsAt
    ? new Date(input.endsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  const expiryHtml = expiryHuman ? `<p style="margin:12px 0 0;font-size:12px;color:#a1a1aa;">Offer ends ${escapeHtml(expiryHuman)}.</p>` : "";
  const codeBlock = `<div style="margin:18px 0 4px;padding:14px;border:1px dashed rgba(255,255,255,0.35);border-radius:12px;text-align:center;"><span style="font-size:20px;font-weight:800;letter-spacing:0.14em;color:#ffffff;">${code}</span></div>`;

  return {
    subject: `${input.headline} — use code ${input.code}`,
    html: renderLayout({
      preheader: `${input.discountLabel} with code ${input.code}`,
      title: headline,
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
      title: `Hi ${name}, please verify your email`,
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
      title: `Hi ${name}, reset your password`,
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
  total: number;
}): EmailTemplate {
  const name = escapeHtml(input.customerName || "there");
  const rows = input.items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;color:#e4e4e7;">${escapeHtml(item.name)} × ${item.quantity}</td><td style="padding:6px 0;text-align:right;color:#e4e4e7;">${money(item.lineTotal)}</td></tr>`,
    )
    .join("");

  return {
    subject: `Order Confirmed - ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} is confirmed.`,
      title: `Thanks, ${name}. Your order is confirmed.`,
      bodyHtml: `
        <p>Order <strong>${escapeHtml(input.orderId)}</strong> has been received and is being prepared.</p>
        <table role="presentation" width="100%" style="margin-top:12px;font-size:14px;">
          ${rows}
          <tr><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);color:#a1a1aa;">Subtotal</td><td style="padding:10px 0 2px;border-top:1px solid rgba(255,255,255,0.1);text-align:right;color:#a1a1aa;">${money(input.subtotal)}</td></tr>
          <tr><td style="padding:2px 0;color:#a1a1aa;">Shipping</td><td style="padding:2px 0;text-align:right;color:#a1a1aa;">${money(input.shipping)}</td></tr>
          ${input.discount > 0 ? `<tr><td style="padding:2px 0;color:#a1a1aa;">Discount</td><td style="padding:2px 0;text-align:right;color:#a1a1aa;">-${money(input.discount)}</td></tr>` : ""}
          <tr><td style="padding:8px 0 0;font-weight:700;color:#ffffff;">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:700;color:#ffffff;">${money(input.total)}</td></tr>
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
      input.discount > 0 ? `Discount: -${money(input.discount)}` : null,
      `Total: ${money(input.total)}`,
      "",
      "- Vanta Labs",
    ]),
  };
}

function paymentMethodLabel(method: string) {
  switch (method) {
    case "cashapp":
      return "Cash App";
    case "zelle":
      return "Zelle";
    case "paypal":
      return "PayPal";
    case "venmo":
      return "Venmo";
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
      title: `Thanks, ${name}. We're verifying your payment.`,
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
      title: `New ${escapeHtml(paymentMethodLabel(input.paymentMethod))} payment to verify`,
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
      title: `${name}, we couldn't verify your payment`,
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
  const trackingLine = input.trackingNumber
    ? `<p>Carrier: ${escapeHtml(input.carrier ?? "")}<br/>Tracking number: ${escapeHtml(input.trackingNumber)}</p>`
    : "";

  return {
    subject: `Shipping Update - ${input.orderId}`,
    html: renderLayout({
      preheader: `Your order ${input.orderId} status: ${input.status}.`,
      title: `${name}, your order status changed`,
      bodyHtml: `<p>Order <strong>${escapeHtml(input.orderId)}</strong> is now: <strong>${escapeHtml(input.status)}</strong>.</p>${trackingLine}`,
      ctaLabel: input.trackingUrl ? "Track Package" : undefined,
      ctaUrl: input.trackingUrl,
    }),
    text: toText([
      `${input.customerName || "there"}, your order status changed.`,
      "",
      `Order ${input.orderId} is now: ${input.status}.`,
      input.trackingNumber ? `Carrier: ${input.carrier ?? ""}` : null,
      input.trackingNumber ? `Tracking number: ${input.trackingNumber}` : null,
      input.trackingUrl ?? null,
      "",
      "- Vanta Labs",
    ]),
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
      title: `${name}, your order was delivered`,
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
      title: `Thanks for applying, ${name}`,
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
  discountPercent?: number;
  storeCreditMultiplierPercent?: number;
  monthlyPostRequirement?: number;
}): EmailTemplate {
  const name = escapeHtml(input.name);
  const commission = input.commissionPercent ?? 10;
  const discount = input.discountPercent ?? 15;
  const creditMultiplier = input.storeCreditMultiplierPercent ?? 125;
  const monthlyPosts = input.monthlyPostRequirement ?? 3;

  const perks = [
    `<strong>${commission}% commission</strong> on every order placed with your code.`,
    `<strong>${discount}% off your own orders</strong> (you don't earn commission on your own orders).`,
    `Get paid in <strong>cash</strong>, or take <strong>store credit worth ${creditMultiplier}%</strong> of your earnings.`,
    `Top-selling ambassador each month earns a <strong>bonus</strong>.`,
  ];

  const perksText = [
    `- ${commission}% commission on every order placed with your code.`,
    `- ${discount}% off your own orders (no commission on your own orders).`,
    `- Get paid in cash, or take store credit worth ${creditMultiplier}% of your earnings.`,
    `- Top-selling ambassador each month earns a bonus.`,
  ];

  return {
    subject: "You're approved — welcome to the Vanta Labs Ambassador program",
    html: renderLayout({
      preheader: "You're approved. Here's how it works.",
      title: `You're approved, ${name}!`,
      bodyHtml: `
        <p>Welcome to the Vanta Labs Ambassador program. Here's what you get:</p>
        <ul>${perks.map((perk) => `<li>${perk}</li>`).join("")}</ul>
        ${input.referralCode ? `<p>Your referral code: <strong>${escapeHtml(input.referralCode)}</strong></p>` : ""}
        <p><strong>To keep your perks:</strong> publish at least <strong>${monthlyPosts} promotional posts, videos, or advertisements per month</strong> featuring Vanta Labs. Consistent promoters earn higher rates and bigger bonuses.</p>
        <p>Open your dashboard to grab your referral link, track commissions, and choose how you get paid.</p>
      `,
      ctaLabel: "Open Dashboard",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Welcome to the Vanta Labs Ambassador program. Here's what you get:",
      ...perksText,
      "",
      input.referralCode ? `Your referral code: ${input.referralCode}` : null,
      "",
      `To keep your perks: publish at least ${monthlyPosts} promotional posts, videos, or advertisements per month featuring Vanta Labs.`,
      "Consistent promoters earn higher rates and bigger bonuses.",
      "",
      `Dashboard: ${input.dashboardUrl}`,
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
      title: `Hi ${name}, an update on your application`,
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
      title: `Nice work, ${name} — you earned a commission`,
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
      title: "New ambassador application",
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
      title: `${name}, your referral code is ready`,
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
      title: `Welcome, ${name}`,
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
      title: `${name}, here's your exact billing schedule`,
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
      title: `${name}, a reminder about your upcoming charge`,
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
      title: `${name}, your payment was successful`,
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
      title: `${name}, your renewal is coming up`,
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
      title: `${name}, your renewal was successful`,
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
      title: `${name}, welcome to ${escapeHtml(input.tierName)}`,
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
      title: `${name}, we couldn't process your payment`,
      bodyHtml: `<p>We attempted to charge <strong>${money(input.amountCents / 100)}</strong> and it didn't go through. Update your payment method to keep your membership active.</p>`,
      ctaLabel: "Update Payment Method",
      ctaUrl: input.updatePaymentUrl,
    }),
    text: toText([`${input.name || "there"}, we couldn't process your payment.`, "", `Amount: ${money(input.amountCents / 100)}`, `Update your payment method: ${input.updatePaymentUrl}`, "", "- Vanta Labs"]),
  };
}

export function membershipBenefitsMonthlyTemplate(input: { name: string; headline: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }): EmailTemplate {
  const name = escapeHtml(input.name || "there");
  return {
    subject: input.headline,
    html: renderLayout({
      preheader: input.headline,
      title: `${name}, ${input.headline}`,
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
      title: `Happy birthday, ${name}!`,
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
      title: `${name}, come back to ${escapeHtml(input.tierName)}`,
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
      title: `${name}, you have early access to ${escapeHtml(input.productName)}`,
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
      title: `${name}, ${escapeHtml(input.productName)} is back`,
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
      title: `${name}, you left something behind`,
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
      title: `${name}, your cart is still here`,
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
      title: `${name}, here's 5% off to complete your order`,
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
      title: `${name}, last chance on your cart`,
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
      title: "We got your message",
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
