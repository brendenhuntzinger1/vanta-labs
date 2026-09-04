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
Information you provide at checkout and when contacting us (name, email, shipping address, order details), and limited technical data such as device type, pages viewed, and referring website.

If you accept analytics (see below), we also generate a random visitor and session identifier stored in your browser, and record any campaign parameters present in the link you arrived through (for example utm_source, utm_medium, utm_campaign, or a click identifier appended by an advertising platform). These are used to understand which marketing efforts lead to orders. They are not linked to your name or email except through an order you actually place.

## How we use it
To process and fulfill orders, verify payments, provide support, send transactional messages, prevent fraud, measure how the site and our marketing perform, and comply with legal obligations. We do not sell your personal information.

## Analytics and advertising technologies
Analytics is off until you accept it. If you decline, no analytics identifiers are created and no analytics events are sent.

When you accept, five things run: our own first-party analytics, which records page views and store events to our own database; Vercel Analytics, a privacy-focused measurement service provided by our hosting provider; the TikTok Pixel; the Snap Pixel; and the Reddit Pixel.

**The TikTok Pixel.** We advertise on TikTok, and the pixel is how we measure whether those adverts work. If you accept cookies, it loads on our pages and sends TikTok your page views along with the technical data any web request carries — IP address, browser and device type, referring page — and an identifier TikTok stores in your browser. TikTok uses this to report advert performance to us and, in line with its own privacy policy, for its own purposes including advert targeting.

It also reports shopping actions: which product pages you view, when you add an item to the cart, when you begin checkout, and when an order is paid. For those events it receives the product identifier, quantity, price, the order value and the currency. It does not receive your name, your address, or the contents of any message you send us.

**One identifier, on one page.** When an order is confirmed as paid, we send TikTok a one-way SHA-256 hash of the email address used for that order. The hash is generated on our server, so your actual address is never handed to code running in your browser and never reaches TikTok. Its purpose is to let TikTok match the purchase to the advert that led to it. A hash cannot be reversed back into an email address, though anyone already holding the same address could confirm a match — so treat it as pseudonymous rather than anonymous. This happens only on a paid order, and only if you accepted cookies. You can ask us to stop it at any time using the contact details above.

**The Snap Pixel.** We also advertise on Snapchat, and this pixel does the same job for those adverts. It loads only if you accept cookies, and it sends Snap the same shape of information: your page views, the technical data any web request carries, an identifier Snap stores in your browser, and the same shopping actions — product viewed, added to cart, checkout begun, order paid — with the product identifier, quantity, price, order value and currency. Snap uses this to report advert performance to us and, in line with its own privacy policy, for its own purposes including advert targeting.

Snap is treated exactly as TikTok is on the point that matters most: your raw email address and phone number are never sent. On a paid order — and only then — Snap receives a one-way SHA-256 hash of each, generated on our server, so the actual values are never handed to code running in your browser and never reach Snap. Snapchat's own setup instructions offer a field for the plain address; we do not use it, and our code refuses to send anything that is not already a hash. Everything in the paragraph above about what a hash is and is not applies here in the same way.

We do not send Snap your age or your location. The pixel is initialised with our advertising account's public identifier and nothing about you.

**The Reddit Pixel.** We also advertise on Reddit. This pixel is narrower than the other two: it loads only if you accept cookies, and it reports your page views together with the technical data any web request carries — IP address, browser and device type, referring page — and an identifier Reddit stores in your browser. Reddit uses this to report advert performance to us and, in line with its own privacy policy, for its own purposes including advert targeting.

It reports shopping actions too: which product pages you view, when you add an item to the cart, and when an order is paid. For those it receives the product identifier, the quantity, the value and the currency. It does not receive your name, your address, or the contents of any message you send us. One difference from the other two: we do not tell Reddit when you begin checkout, only when an order completes.

**If you are signed in, Reddit also receives a hash.** Reddit calls this Advanced Matching, and it is how it links a visit to an advert you saw. When you are signed in to an account and have accepted cookies, we send Reddit a one-way SHA-256 hash of your email address and a second hash of your internal account number. Both are generated on our server, so your actual address is never handed to code running in your browser and never reaches Reddit. Reddit's own setup instructions offer a field for the plain address and will hash it in your browser instead; we do not use it, and the hash we send is identical either way. Signed out, or browsing as a guest, nothing identifying you is sent at all.

A hash cannot be reversed back into an email address, though anyone already holding the same address could confirm a match — so treat it as pseudonymous rather than anonymous. This is the same treatment TikTok and Snap already receive, with one difference worth stating plainly: for those two it happens only on a paid order, whereas Reddit receives it on page views while you are signed in. You can stop it at any time by declining cookies, signing out, or asking us using the contact details above.

If you decline cookies, none of these pixels are loaded at all. No request is made to TikTok, Snap or Reddit, no identifier is set, and no platform receives anything about your visit.

We do not run a Meta pixel, a Google Ads tag or any equivalent technology. If we add one, this policy and our Cookie Policy will be updated to name the platform, the data shared and the purpose before it is switched on.

## Sharing
Only with service providers that help us operate — payment processing, email delivery, hosting, analytics and shipping — as needed to run the store, or as required by law.

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
See our Return & Reimbursement Policy. Memberships are non-refundable.

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

## Shipping Protection (optional)
Shipping Protection is an optional, store-backed service — not third-party insurance — added to your order by default for a small fee based on your order total. It is shown as a separate line item in your cart and at checkout, and you can remove it with one click at any time before you pay. Express wallet checkouts (Apple Pay, Google Pay) never add it on your behalf — there, protection is included only if you chose to keep it before starting the express payment.

**What it covers:** with protection added, if your order is lost in transit, stolen after delivery, or arrives damaged, we will replace the affected items or refund them, at our discretion.

**What it does not cover:** orders shipped to an incorrect or incomplete address you provided; packages marked delivered by the carrier and not reported within the claim window; items damaged by misuse after delivery; and delays alone (a late but delivered package is not a covered loss).

**How to file a claim:** contact ${email} with your order number within 14 days of the delivery date (or expected delivery date for a lost package). Include photos for damage claims. We may ask you to complete a short carrier claim statement.

**Refund behavior:** an approved claim is resolved by replacement or refund of the affected items. The protection fee itself is non-refundable once an order has shipped. If you did not add protection, lost/stolen/damaged shipments are handled case-by-case at our discretion and are not guaranteed.

## Issues
For lost, delayed, or damaged shipments, contact ${email} with your order number.`,
  },
  refund: {
    title: "Return & Reimbursement Policy",
    body: `Clear, straightforward support when something is wrong with your order.

## Contact us before sending anything back
Please do not mail a product back before contacting us. Email ${email} with your order number, the name or email on the order, the product involved, and the reason for the return. If your return is approved, we'll reply with return instructions.

A product mailed back without prior authorization is not an approved return.

## Standard returns
To be eligible for a standard return, a product must:

- have its return requested within **14 days of delivery**
- be unused and unopened
- retain its **original factory cap/seal, fully intact**
- be in its original condition

Products that have been opened, used, punctured, reconstituted, altered, or that have had the factory seal removed or broken are not eligible for a standard return.

Customers are responsible for return shipping on ordinary returns.

Once an approved return is received and inspected, Vanta Labs will arrange the applicable reimbursement with you.

## Damaged, missing or incorrect items
This is separate from a standard return, and the sealed-product requirement does not apply.

If your order arrives damaged or broken, is missing an item, or contains the wrong item, email ${email} promptly with your order number and photographs where applicable. We'll make it right.

## Cancellations
If you need to cancel, email ${email} as soon as possible. We can usually cancel an order before it has been packed and a shipping label has been purchased. Once an order is on its way to the carrier we can no longer cancel it, and it is handled as a return or a delivery issue instead.

## Memberships
Membership charges are non-refundable. You keep access for the remainder of your paid term and can cancel anytime to stop auto-renewal.

## Questions
Email ${email} and we'll help.`,
  },
  cookies: {
    title: "Cookie Policy",
    body: `This site uses cookies and similar technologies to operate the store and improve your experience.

## What we use
**Essential** — cart contents, checkout state, login sessions, and your age confirmation. These are always on; the store cannot work without them.

**Analytics — only if you accept.** A random visitor and session identifier stored in your browser, any campaign parameters from the link you arrived through, and Vercel Analytics, our hosting provider's privacy-focused measurement service. Nothing in this category is created or sent unless you choose Accept on the cookie banner.

**Advertising — only if you accept.** Three pixels, which measure whether our adverts lead to visits and orders: the TikTok Pixel, the Snap Pixel and the Reddit Pixel. Each sets an identifier in your browser and sends its platform your page views together with the technical data any web request carries. All three additionally receive shopping actions — product viewed, added to cart, order paid — and Reddit receives a one-way hash of your email address while you are signed in. Declining means none of them is ever loaded, so no request reaches TikTok, Snap or Reddit and no identifier is set. We do not run a Meta pixel, a Google Ads tag or any equivalent.

## Your choices
Choosing Decline on the banner stops all non-essential storage; nothing in the analytics category is created. Your choice is remembered in your browser. To change it, clear this site's data in your browser and the banner will appear again on your next visit. You can also control cookies through your browser settings, though disabling essential cookies may break checkout or login.

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
