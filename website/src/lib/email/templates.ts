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
