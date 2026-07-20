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

export function ambassadorApprovedTemplate(input: { name: string; referralCode?: string; dashboardUrl: string }): EmailTemplate {
  const name = escapeHtml(input.name);
  return {
    subject: "Your Vanta Labs Ambassador Application Was Approved",
    html: renderLayout({
      preheader: "You're approved. Your dashboard is ready.",
      title: `You're approved, ${name}!`,
      bodyHtml: `
        <p>Your ambassador application has been approved.</p>
        ${input.referralCode ? `<p>Your referral code: <strong>${escapeHtml(input.referralCode)}</strong></p>` : ""}
        <p>Log in to access your dashboard, referral link, commissions, and payouts.</p>
      `,
      ctaLabel: "Open Dashboard",
      ctaUrl: input.dashboardUrl,
    }),
    text: toText([
      `Hi ${input.name},`,
      "",
      "Your ambassador application has been approved.",
      input.referralCode ? `Referral code: ${input.referralCode}` : null,
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
