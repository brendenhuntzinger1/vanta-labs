import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";
import { DEFAULT_BUSINESS_SETTINGS } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// Legal / policy content — editable from the admin dashboard.
//
// Every policy page renders from here. The coded defaults below are the
// launch-ready starting point; an admin can override any policy's title/body
// from Admin → Policies (stored in the "legal" control section, keyed by
// slug) without touching code. Body uses a tiny, safe markup: a line starting
// with "## " is a heading; blank lines separate paragraphs. HTML is escaped.
// -------------------------------------------------------------------------

export const POLICY_SLUGS = [
  "research-disclaimer",
  "privacy",
  "terms",
  "shipping",
  "refund",
  "cookies",
] as const;

export type PolicySlug = (typeof POLICY_SLUGS)[number];

export interface PolicyContent {
  slug: PolicySlug;
  title: string;
  updated: string;
  body: string;
}

const email = DEFAULT_BUSINESS_SETTINGS.supportEmail;

const DEFAULTS: Record<PolicySlug, { title: string; body: string }> = {
  "research-disclaimer": {
    title: "Research Disclaimer",
    body: `All products sold on this website are intended strictly for laboratory and research use only. They are not drugs, dietary supplements, food, cosmetics, or medical devices, and are not intended to diagnose, treat, cure, or prevent any disease.

## Not for human or animal use
Products are not for human or veterinary consumption. No instructions for preparation, dosage, or administration are provided or should be inferred. The purchaser assumes full responsibility for safe handling, storage, and lawful use.

## Eligibility
By purchasing, you confirm you are at least 21 years old, a qualified researcher or institution, and legally permitted to purchase these materials in your jurisdiction.

## No medical advice
Nothing on this website constitutes medical, scientific, or professional advice.

## Contact
Questions can be sent to ${email}.`,
  },
  privacy: {
    title: "Privacy Policy",
    body: `This policy explains what information we collect, how we use it, and the choices you have.

## Information we collect
Information you provide at checkout and when contacting us (name, email, shipping address, order details), and limited technical data such as device and usage analytics.

## How we use it
To process and fulfill orders, verify payments, provide support, send transactional messages, prevent fraud, and comply with legal obligations. We do not sell your personal information.

## Sharing
Only with service providers that help us operate (payment, email, hosting, fulfillment) as needed, or as required by law.

## Data retention & security
We retain order records as required for accounting and legal purposes and use reasonable safeguards to protect your information.

## Your choices
You may request access to, correction of, or deletion of your personal information, and can unsubscribe from marketing emails anytime. Contact ${email}.`,
  },
  terms: {
    title: "Terms of Service",
    body: `These terms govern your use of this website and any purchase you make.

## Eligibility & acceptable use
You must be at least 21 and legally permitted to purchase laboratory research materials in your jurisdiction. You agree to use the site lawfully and provide accurate information at checkout.

## Research use only
All products are sold strictly for laboratory research use and are not for human or animal consumption. See our Research Disclaimer.

## Orders, pricing & payment
We may accept or decline any order. Prices, fees, and availability may change without notice. Manual payments are verified before fulfillment; a card processing fee, where shown, is disclosed before you submit payment.

## Shipping & fulfillment
Orders ship after payment is verified. Delivery times are estimates. Risk of loss passes to you on delivery to the carrier.

## Returns & refunds
See our Return & Refund Policy. Memberships are non-refundable.

## Limitation of liability
To the maximum extent permitted by law, the seller is not liable for indirect, incidental, or consequential damages arising from the use or misuse of any product.

## Contact
${email}`,
  },
  shipping: {
    title: "Shipping Policy",
    body: `## Processing
Orders are prepared after payment is verified.

## Rates
Domestic shipping is free over the current threshold; otherwise, a flat fee applies. International shipping has its own threshold and flat fee. Exact shipping is shown at checkout before you pay.

## Delivery
Delivery times are estimates and are not guaranteed. Once shipped, you'll receive tracking by email.

## Issues
For lost, delayed, or damaged shipments, contact ${email} with your order number.`,
  },
  refund: {
    title: "Return & Refund Policy",
    body: `## Research materials
Due to the nature of these materials, returns are limited and may not be accepted once shipped. Eligibility is handled case by case.

## Damaged or incorrect orders
If your order arrives damaged or incorrect, contact ${email} within a reasonable time with your order number and photos, and we'll make it right.

## Memberships
Membership charges are non-refundable. Annual memberships are non-refundable; you keep access for the remainder of your paid term and can cancel anytime to stop auto-renewal.

## How to request
Email ${email} with your order number and reason. Approved refunds are issued to the original payment method where possible.`,
  },
  cookies: {
    title: "Cookie Policy",
    body: `This site uses cookies and similar technologies to operate the store and improve your experience.

## What we use
Essential cookies (cart, checkout, login sessions), and privacy-friendly analytics to understand site usage.

## Your choices
You can control cookies through your browser settings. Disabling essential cookies may break checkout or login.

## Contact
Questions about this policy can be sent to ${email}.`,
  },
};

export async function getPolicy(slug: PolicySlug): Promise<PolicyContent> {
  const fallback = DEFAULTS[slug];
  try {
    const snapshot = await getControlSnapshot("legal");
    const override = (snapshot.legal ?? {})[slug] as { title?: string; body?: string; updated?: string } | undefined;
    return {
      slug,
      title: (override?.title && override.title.trim()) || fallback.title,
      updated: (override?.updated && String(override.updated).trim()) || "2026",
      body: (override?.body && override.body.trim()) || fallback.body,
    };
  } catch {
    return { slug, title: fallback.title, updated: "2026", body: fallback.body };
  }
}

export async function getAllPolicies(): Promise<PolicyContent[]> {
  return Promise.all(POLICY_SLUGS.map((slug) => getPolicy(slug)));
}

export function isPolicySlug(value: string): value is PolicySlug {
  return (POLICY_SLUGS as readonly string[]).includes(value);
}
