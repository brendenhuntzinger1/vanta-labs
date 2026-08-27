# Google Ads Tracking Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Ads as a fourth conversion-tracking channel alongside the audited TikTok, Snap and Reddit integrations, without modifying how any of them report.

**Architecture:** Google is built as a peer, not an abstraction: a pure event-builder module, a consent-gated browser pixel, a `server-only` Enhanced Conversions leg, and health rows — each mirroring the equivalent Reddit/Snap file. All four channels are built from ONE `PaidOrder` read once by `/api/ads/purchase-event/[orderId]`, which is the only place in the codebase that decides a purchase happened. Browser and server legs share `transaction_id = orderId`, and a per-platform send-ledger makes deduplication permanent.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Playwright, Supabase (Postgres), Vercel.

**Spec:** `docs/superpowers/specs/2026-08-27-google-ads-tracking-design.md`

## Global Constraints

These apply to **every** task. They are not restated per task.

- **Never invent a number.** Every monetary figure traces to a settled order figure or a catalogue price. Do not add a second pricing calculation anywhere.
- **Purchase is gated on the backend's `payment_status`, never on a URL.** Reaching a confirmation page must never be able to produce a conversion.
- **Do not modify `src/lib/ads/advanced-matching.ts`.** Its digests are already sent to TikTok and Snap; changing normalisation there silently changes what those platforms receive. Google gets its own module.
- **Do not modify `tiktok-events.ts`, `snap-events.ts`, `reddit-events.ts` or `reddit-conversions.ts`.** Import from them; never edit them.
- **No Google credential is ever prefixed `NEXT_PUBLIC_`** except `NEXT_PUBLIC_GOOGLE_ADS_ID` and `NEXT_PUBLIC_GOOGLE_PURCHASE_LABEL`, which are public by design.
- **Identity is hashed server-side only.** A value that is not 64 lowercase hex characters is dropped, never sent.
- **Deny by default on environment.** Every reporting path passes `browserAdsReportingAllowed()` or `serverAdsReportingAllowed()`. Do not add an override env var.
- **The `AW-` literal appears in exactly one file.** `single-data-source.test.ts` enforces this.
- **Out of scope, do not build:** campaigns, ad groups, keywords, ad copy, bidding, budgets, alternate landing pages.
- Currency constant: `"USD"`. Google conversion ID format: `/^AW-\d+$/`.
- Test runner: `npm test` (vitest). Lint: `npm run lint`. Build: `npm run build`. All run from `website/`.

---

### Task 1: The conversion ID, in one place

**Files:**
- Create: `website/src/lib/ads/google-conversion-id.ts`
- Modify: `website/src/lib/ads/single-data-source.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GOOGLE_ADS_ID: string`, `GOOGLE_PURCHASE_LABEL: string`, `isConfiguredGoogleAdsId(value: string): boolean`.

Mirrors `reddit-pixel-id.ts`: both a `"use client"` component and a `server-only` module need these values, so the module imports nothing.

Unlike Reddit's, there is **no hard-coded production fallback** — the account does not exist yet, and an empty string is what keeps the pixel inert (Task 4).

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/google-conversion-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isConfiguredGoogleAdsId } from "./google-conversion-id";

describe("isConfiguredGoogleAdsId", () => {
  it("accepts a real Google Ads conversion id", () => {
    expect(isConfiguredGoogleAdsId("AW-123456789")).toBe(true);
  });

  it("rejects an empty value, which is how the pixel stays inert before the account exists", () => {
    expect(isConfiguredGoogleAdsId("")).toBe(false);
  });

  it("rejects a placeholder left in by mistake", () => {
    expect(isConfiguredGoogleAdsId("AW-XXXXXXXXX")).toBe(false);
  });

  it("rejects a GA4 measurement id, which is a different product and would report nothing", () => {
    expect(isConfiguredGoogleAdsId("G-ABC123")).toBe(false);
  });

  it("rejects a bare number with no AW- prefix", () => {
    expect(isConfiguredGoogleAdsId("123456789")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-conversion-id.test.ts`
Expected: FAIL — "Failed to resolve import ./google-conversion-id".

- [ ] **Step 3: Write minimal implementation**

Create `website/src/lib/ads/google-conversion-id.ts`:

```ts
/**
 * The Google Ads conversion id and purchase label, in one place.
 *
 * Both the browser pixel and the server-side Enhanced Conversions leg need
 * them. Two hard-coded copies would be two things to update and one to forget,
 * and the failure would be quiet in the worst way: the tag loading for one
 * conversion action while conversions report to another, with neither path
 * erroring. single-data-source.test.ts asserts the literal appears once.
 *
 * Kept free of any import so a "use client" component and a `server-only`
 * module can both take it without dragging the other's dependencies along.
 *
 * UNLIKE THE OTHER THREE CHANNELS, THERE IS NO PRODUCTION FALLBACK VALUE. The
 * Google Ads account does not exist yet. An empty string is not an oversight —
 * it is what keeps the pixel inert: GooglePixel renders nothing when this does
 * not match the expected shape, so merging this work cannot start reporting to
 * an account nobody has verified.
 */
export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID ?? "";

export const GOOGLE_PURCHASE_LABEL = process.env.NEXT_PUBLIC_GOOGLE_PURCHASE_LABEL ?? "";

/**
 * A conversion id we are willing to load a third-party script for.
 *
 * `G-` prefixed ids are GA4 measurement ids. They are superficially similar,
 * they are commonly pasted here by mistake, and gtag accepts one without
 * complaint while reporting no conversions at all — so the shape is checked
 * rather than assumed non-empty.
 */
export function isConfiguredGoogleAdsId(value: string): boolean {
  return /^AW-\d+$/.test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd website && npx vitest run src/lib/ads/google-conversion-id.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Extend the single-source invariant**

In `website/src/lib/ads/single-data-source.test.ts`, add this test inside the existing top-level `describe`:

```ts
  // Matches the env READ, not the bare name: google-health.ts names the variable
  // in the action text it shows an operator, which is not a second source.
  it("declares the Google Ads conversion id in exactly one file", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith("google-conversion-id.ts"))
      .filter((path) => /process\.env\.NEXT_PUBLIC_GOOGLE_ADS_ID|["'`]AW-\d+["'`]/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 6: Run the full single-source suite**

Run: `cd website && npx vitest run src/lib/ads/single-data-source.test.ts`
Expected: PASS. Every pre-existing test in the file still passes.

- [ ] **Step 7: Commit**

```bash
git add website/src/lib/ads/google-conversion-id.ts website/src/lib/ads/google-conversion-id.test.ts website/src/lib/ads/single-data-source.test.ts
git commit -m "feat(ads): declare the Google Ads conversion id in one place

No production fallback, deliberately: the account does not exist yet and
an empty value is what keeps the pixel inert. Shape-checked so a GA4
measurement id pasted here is refused rather than silently reporting
nothing."
```

---

### Task 2: Google identity normalisation

**Files:**
- Create: `website/src/lib/ads/google-matching.ts`
- Test: `website/src/lib/ads/google-matching.test.ts`

**Interfaces:**
- Consumes: nothing. (Deliberately NOT `advanced-matching.ts` — see below.)
- Produces: `normalizeGoogleEmail(email): string | null`, `normalizeGooglePhone(phone): string | null`, `buildGoogleIdentity(input: { email?: string | null; phone?: string | null }): GoogleIdentity | null`, `type GoogleIdentity = { hashedEmail?: string; hashedPhone?: string }`.

**Why this is a separate module and not a change to `advanced-matching.ts`.** Google's canonicalisation differs from TikTok's in two ways that matter, and both would break existing channels if applied globally:

- Google requires Gmail addresses with dots and `+suffixes` stripped. `normalizeEmail` does neither. Adding it there would change the digest TikTok and Snap already send for every Gmail customer, silently detaching new conversions from the existing match history.
- Google requires E.164 **with** the leading `+`. `normalizePhone` deliberately strips it, because that is what TikTok expects.

Two platforms, two normalisations, no shared mutation.

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/google-matching.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGoogleIdentity, normalizeGoogleEmail, normalizeGooglePhone } from "./google-matching";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("normalizeGoogleEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeGoogleEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("strips dots from gmail local parts, which Google treats as identical", () => {
    expect(normalizeGoogleEmail("first.last@gmail.com")).toBe("firstlast@gmail.com");
  });

  it("strips a plus suffix from gmail", () => {
    expect(normalizeGoogleEmail("person+shopping@gmail.com")).toBe("person@gmail.com");
  });

  it("treats googlemail.com the same as gmail.com", () => {
    expect(normalizeGoogleEmail("first.last@googlemail.com")).toBe("firstlast@googlemail.com");
  });

  it("does NOT strip dots from non-gmail domains, where they are significant", () => {
    expect(normalizeGoogleEmail("first.last@vantalabs.com")).toBe("first.last@vantalabs.com");
  });

  it("returns null for anything that is not an address", () => {
    expect(normalizeGoogleEmail("not-an-email")).toBeNull();
    expect(normalizeGoogleEmail("")).toBeNull();
    expect(normalizeGoogleEmail(null)).toBeNull();
  });
});

describe("normalizeGooglePhone", () => {
  it("returns E.164 WITH the leading plus, unlike the TikTok normaliser", () => {
    expect(normalizeGooglePhone("(555) 010-1234")).toBe("+5550101234");
  });

  it("does not double the plus on an already-E.164 number", () => {
    expect(normalizeGooglePhone("+15550101234")).toBe("+15550101234");
  });

  it("returns null for a number too short to be real", () => {
    expect(normalizeGooglePhone("1234")).toBeNull();
  });
});

describe("buildGoogleIdentity", () => {
  it("hashes the normalised email", () => {
    expect(buildGoogleIdentity({ email: "First.Last+promo@GMAIL.com" })).toEqual({
      hashedEmail: sha256("firstlast@gmail.com"),
    });
  });

  it("omits a field it does not genuinely have rather than hashing an empty string", () => {
    expect(buildGoogleIdentity({ email: "person@example.com", phone: "" })).toEqual({
      hashedEmail: sha256("person@example.com"),
    });
  });

  it("returns null when it has no identity at all", () => {
    expect(buildGoogleIdentity({ email: null, phone: null })).toBeNull();
  });

  it("never returns a raw address in any field", () => {
    const identity = buildGoogleIdentity({ email: "person@example.com", phone: "+15550101234" });
    expect(JSON.stringify(identity)).not.toContain("person@example.com");
    expect(JSON.stringify(identity)).not.toContain("5550101234");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-matching.test.ts`
Expected: FAIL — "Failed to resolve import ./google-matching".

- [ ] **Step 3: Write minimal implementation**

Create `website/src/lib/ads/google-matching.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * Google's identity normalisation, kept deliberately apart from
 * advanced-matching.ts.
 *
 * It would be tempting to add Google's rules to the existing normaliser and
 * have one function for all four channels. That would be a silent regression.
 * TikTok and Snap have been sending SHA-256 digests of addresses normalised
 * the existing way for the whole life of those integrations; strip dots from
 * Gmail addresses there and every Gmail customer's digest changes, detaching
 * new conversions from the match history already built against the old one.
 *
 * Google's two divergences:
 *
 *   EMAIL — dots and `+suffixes` are removed from gmail.com and googlemail.com
 *   local parts, because Google itself treats them as the same mailbox. They
 *   are NOT removed elsewhere, where a dot is a significant character and
 *   removing it would produce a digest for an address that does not exist.
 *
 *   PHONE — E.164 WITH the leading plus. advanced-matching.ts strips it,
 *   correctly, because that is what TikTok wants.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lowercased, trimmed, Gmail-canonicalised. Null for anything not an address. */
export function normalizeGoogleEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  const at = value.lastIndexOf("@");
  const domain = value.slice(at + 1);
  if (!GOOGLE_MAIL_DOMAINS.has(domain)) return value;

  // Gmail only. A dot is significant in most local parts.
  const local = value.slice(0, at).split("+")[0].replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * E.164 including the leading plus, which is what Google expects and the
 * opposite of what the TikTok normaliser produces.
 */
export function normalizeGooglePhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export type GoogleIdentity = {
  hashedEmail?: string;
  hashedPhone?: string;
};

/**
 * Build the identity, omitting anything we do not genuinely have.
 *
 * An empty or placeholder value is worse than an absent one: it pollutes the
 * match set with a digest of the empty string, which every customer lacking
 * that field would share.
 */
export function buildGoogleIdentity(input: {
  email?: string | null;
  phone?: string | null;
}): GoogleIdentity | null {
  const identity: GoogleIdentity = {};

  const email = normalizeGoogleEmail(input.email);
  if (email) identity.hashedEmail = sha256(email);

  const phone = normalizeGooglePhone(input.phone);
  if (phone) identity.hashedPhone = sha256(phone);

  return Object.keys(identity).length > 0 ? identity : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd website && npx vitest run src/lib/ads/google-matching.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Prove the existing channels were not disturbed**

Run: `cd website && npx vitest run src/lib/ads/advanced-matching.test.ts`
Expected: PASS, unmodified. If this file changed, the task is wrong — revert it.

- [ ] **Step 6: Commit**

```bash
git add website/src/lib/ads/google-matching.ts website/src/lib/ads/google-matching.test.ts
git commit -m "feat(ads): Google identity normalisation, separate from TikTok's

Google canonicalises Gmail (dots and +suffixes stripped) and wants E.164
with the leading plus; advanced-matching.ts does neither, deliberately.
Applying Google's rules there would change the digests TikTok and Snap
already send for every Gmail customer, so Google gets its own module."
```

---

### Task 3: The pure event builders

**Files:**
- Create: `website/src/lib/ads/google-events.ts`
- Test: `website/src/lib/ads/google-events.test.ts`

**Interfaces:**
- Consumes: `money`, `resolveContentId`, `type PaidOrder` from `./tiktok-events`; `type GoogleIdentity` from `./google-matching`; `GOOGLE_PURCHASE_LABEL` from `./google-conversion-id`.
- Produces: `type GoogleEventName`, `type GoogleEvent`, `GOOGLE_CURRENCY`, `hashedOnly(value): string | undefined`, `buildGoogleViewItem`, `buildGoogleAddToCart`, `buildGoogleBeginCheckout`, `buildGooglePurchase(order: PaidOrder, options?): GoogleEvent | null`, `emitGoogleEvent(event, emit, store): boolean`.

No DOM, no network, no `process.env` reads beyond the imported constant. Every input is passed in, so the whole module is testable without a browser or a database.

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/google-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildGoogleAddToCart,
  buildGoogleBeginCheckout,
  buildGooglePurchase,
  buildGoogleViewItem,
  emitGoogleEvent,
  hashedOnly,
} from "./google-events";
import type { PaidOrder } from "./tiktok-events";

const paidOrder: PaidOrder = {
  orderId: "VL-1001",
  isPaid: true,
  amountPaid: 149.99,
  items: [
    { slug: "bpc-157", productId: "prod_1", productName: "BPC-157", quantity: 2, unitPrice: 59.995 },
    { slug: "tb-500", productId: "prod_2", productName: "TB-500", quantity: 1, unitPrice: 30 },
  ],
};

describe("buildGooglePurchase — the paid gate", () => {
  it("reports a paid order", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.name).toBe("purchase");
    expect(event?.params.value).toBe(149.99);
    expect(event?.params.currency).toBe("USD");
    expect(event?.params.transaction_id).toBe("VL-1001");
  });

  it("returns null for an unpaid order, however complete it looks", () => {
    expect(buildGooglePurchase({ ...paidOrder, isPaid: false })).toBeNull();
  });

  it("returns null for a zero-value order — a fully-discounted sale is not revenue to learn from", () => {
    expect(buildGooglePurchase({ ...paidOrder, amountPaid: 0 })).toBeNull();
  });

  it("returns null for a negative amount", () => {
    expect(buildGooglePurchase({ ...paidOrder, amountPaid: -10 })).toBeNull();
  });

  it("returns null without an order id, since there would be nothing to deduplicate on", () => {
    expect(buildGooglePurchase({ ...paidOrder, orderId: "" })).toBeNull();
  });
});

describe("buildGooglePurchase — the money", () => {
  it("reports the settled total, never a recomputed sum of the lines", () => {
    // The lines sum to 149.99 here, but the settled figure is authoritative
    // even when they disagree — shipping, tax and discounts live in it.
    const event = buildGooglePurchase({ ...paidOrder, amountPaid: 131.5 });
    expect(event?.params.value).toBe(131.5);
  });

  it("rounds to two decimal places rather than emitting float noise", () => {
    const event = buildGooglePurchase({ ...paidOrder, amountPaid: 10.005 });
    expect(event?.params.value).toBe(10.01);
  });

  it("does not send shipping or tax, which the order shape does not carry", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.params).not.toHaveProperty("shipping");
    expect(event?.params).not.toHaveProperty("tax");
  });
});

describe("buildGooglePurchase — product identity", () => {
  it("identifies products by catalogue slug, matching every other channel", () => {
    const event = buildGooglePurchase(paidOrder);
    expect(event?.params.items?.map((item) => item.item_id)).toEqual(["bpc-157", "tb-500"]);
  });

  it("falls back to the product id when a slug is missing", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: "prod_9", productName: "Unslugged", quantity: 1, unitPrice: 10 }],
    });
    expect(event?.params.items?.[0].item_id).toBe("prod_9");
  });

  it("never uses a product name as an identifier", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: null, productName: "BPC-157", quantity: 1, unitPrice: 10 }],
    });
    expect(JSON.stringify(event?.params.items)).not.toContain("BPC-157");
  });

  it("identifies the order itself when no line resolves, rather than reporting nothing", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: null, productId: null, productName: "Mystery", quantity: 1, unitPrice: 10 }],
    });
    expect(event?.params.items).toEqual([
      { item_id: "order-VL-1001", item_name: "Order (line items unresolved)", quantity: 1, price: 149.99 },
    ]);
  });

  it("floors a fractional quantity to at least one", () => {
    const event = buildGooglePurchase({
      ...paidOrder,
      items: [{ slug: "bpc-157", productId: "p", productName: "n", quantity: 0, unitPrice: 10 }],
    });
    expect(event?.params.items?.[0].quantity).toBe(1);
  });
});

describe("buildGooglePurchase — deduplication identity", () => {
  it("derives transaction_id from the order, never randomly", () => {
    const a = buildGooglePurchase(paidOrder);
    const b = buildGooglePurchase(paidOrder);
    expect(a?.params.transaction_id).toBe(b?.params.transaction_id);
    expect(a?.params.transaction_id).toBe("VL-1001");
  });

  it("carries a dedupe key scoped to google and the order", () => {
    expect(buildGooglePurchase(paidOrder)?.dedupeKey).toBe("google-purchase:VL-1001");
  });
});

describe("hashedOnly", () => {
  it("accepts a SHA-256 digest", () => {
    const digest = "a".repeat(64);
    expect(hashedOnly(digest)).toBe(digest);
  });

  it("drops a raw email address rather than forwarding it", () => {
    expect(hashedOnly("person@example.com")).toBeUndefined();
  });

  it("drops Google's own placeholder text", () => {
    expect(hashedOnly("INSERT_USER_EMAIL")).toBeUndefined();
  });

  it("drops a digest of the wrong length", () => {
    expect(hashedOnly("abc123")).toBeUndefined();
  });
});

describe("buildGooglePurchase — identity", () => {
  it("attaches hashed identity when given it", () => {
    const digest = "b".repeat(64);
    const event = buildGooglePurchase(paidOrder, { identity: { hashedEmail: digest } });
    expect(event?.userData?.sha256_email_address).toBe(digest);
  });

  it("cannot be made to send a raw address", () => {
    const event = buildGooglePurchase(paidOrder, {
      identity: { hashedEmail: "person@example.com" as string },
    });
    expect(JSON.stringify(event)).not.toContain("person@example.com");
    expect(event?.userData).toBeUndefined();
  });
});

describe("the upper funnel", () => {
  it("builds view_item from a catalogue slug", () => {
    const event = buildGoogleViewItem({ slug: "bpc-157", price: 59.99 });
    expect(event?.name).toBe("view_item");
    expect(event?.params.items?.[0].item_id).toBe("bpc-157");
    expect(event?.params.value).toBe(59.99);
  });

  it("refuses to build view_item without a slug", () => {
    expect(buildGoogleViewItem({ slug: "" })).toBeNull();
  });

  it("builds add_to_cart with quantity and value", () => {
    const event = buildGoogleAddToCart({ slug: "bpc-157", price: 59.99, quantity: 2 });
    expect(event?.name).toBe("add_to_cart");
    expect(event?.params.value).toBe(119.98);
    expect(event?.params.items?.[0].quantity).toBe(2);
  });

  it("builds begin_checkout from the cart total", () => {
    const event = buildGoogleBeginCheckout({
      value: 149.99,
      items: [{ slug: "bpc-157", quantity: 2, price: 59.995 }],
    });
    expect(event?.name).toBe("begin_checkout");
    expect(event?.params.value).toBe(149.99);
  });

  it("refuses to build begin_checkout for an empty cart", () => {
    expect(buildGoogleBeginCheckout({ value: 0, items: [] })).toBeNull();
  });
});

describe("emitGoogleEvent", () => {
  it("emits once and honours the dedupe key", () => {
    const seen = new Set<string>();
    const store = { has: (k: string) => seen.has(k), mark: (k: string) => void seen.add(k) };
    const calls: string[] = [];
    const emit = (name: string) => void calls.push(name);

    const event = buildGooglePurchase(paidOrder);
    expect(emitGoogleEvent(event, emit, store)).toBe(true);
    expect(emitGoogleEvent(event, emit, store)).toBe(false);
    expect(calls).toEqual(["purchase"]);
  });

  it("emits nothing for a null event", () => {
    const store = { has: () => false, mark: () => {} };
    expect(emitGoogleEvent(null, () => {}, store)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-events.test.ts`
Expected: FAIL — "Failed to resolve import ./google-events".

- [ ] **Step 3: Write minimal implementation**

Create `website/src/lib/ads/google-events.ts`:

```ts
/**
 * Google Ads ecommerce events — the pure half.
 *
 * A deliberate mirror of snap-events.ts and tiktok-events.ts: same funnel, same
 * authoritative numbers, same derived-not-random identifiers. Four ad platforms
 * disagreeing about the same order is a reporting problem nobody notices until
 * they are reconciling spend, so all four are built from the same inputs and
 * the same rules.
 *
 * Three things carry over unchanged because they are the rules that matter:
 *
 * **Never invent a number.** Every price traces to a catalogue or settled
 * figure.
 *
 * **Purchase is gated on the backend's paid state, never on a URL.**
 *
 * **One action, one event.** `transaction_id` is derived from the order it
 * describes, which is what lets Google collapse a browser event and an
 * Enhanced Conversions event into one conversion instead of two.
 *
 * The product identifier is the SAME catalogue slug TikTok, Snap and Reddit
 * receive. Reporting a product as `bpc-157` on one platform and something else
 * on another makes cross-channel comparison impossible for no benefit.
 *
 * ON SHIPPING AND TAX. Google's purchase event accepts optional `shipping` and
 * `tax` parameters and they are deliberately not sent. `PaidOrder` carries
 * neither, and the only ways to produce them would be to add a second read of
 * the order or to recompute them here — the second pricing calculation this
 * codebase does not permit. `value` is `amountPaid`, the settled total, which
 * is inclusive of both by construction and is the figure bidding uses. A wrong
 * breakdown is worse than an absent one.
 *
 * ON THE IDENTITY FIELDS. Google's Enhanced Conversions documentation offers
 * both raw and hashed forms. Only the hashed form is accepted here, and
 * `hashedOnly` enforces it structurally: a value that is not a 64-character
 * SHA-256 digest is dropped rather than sent. The digests are produced
 * server-side by google-matching.ts. This module never sees a raw address.
 */

import { money, resolveContentId, type PaidOrder } from "./tiktok-events";
import type { GoogleIdentity } from "./google-matching";

/** Google's standard ecommerce event names. Lowercase snake_case. */
export type GoogleEventName = "page_view" | "view_item" | "add_to_cart" | "begin_checkout" | "purchase";

export type GoogleItem = {
  item_id: string;
  item_name?: string;
  quantity?: number;
  price?: number;
};

export type GoogleEvent = {
  name: GoogleEventName;
  params: {
    value?: number;
    currency?: string;
    /** Google's deduplication key for a purchase. Derived, never random. */
    transaction_id?: string;
    items?: GoogleItem[];
  };
  /** Enhanced Conversions identity. Digests only — see hashedOnly. */
  userData?: {
    sha256_email_address?: string;
    sha256_phone_number?: string;
  };
  /** Storage key that makes this event fire at most once where that matters. */
  dedupeKey: string | null;
};

export const GOOGLE_CURRENCY = "USD";

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function countOf(quantity: unknown): number {
  return Math.max(1, Math.floor(Number(quantity) || 1));
}

/**
 * Accepts a SHA-256 digest and nothing else.
 *
 * The point is not validation for its own sake. Google's own setup guides show
 * `email: 'INSERT_USER_EMAIL'` in this position, and the failure mode of
 * pasting that is silent: a raw customer address goes to a third party on every
 * event and nothing looks broken. Refusing anything that is not 64 hex
 * characters means the mistake cannot be made here — a raw address is dropped,
 * not forwarded.
 */
export function hashedOnly(value: string | null | undefined): string | undefined {
  const digest = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function userDataFrom(identity: GoogleIdentity | null | undefined): GoogleEvent["userData"] {
  if (!identity) return undefined;
  const email = hashedOnly(identity.hashedEmail);
  const phone = hashedOnly(identity.hashedPhone);
  if (!email && !phone) return undefined;
  return {
    ...(email ? { sha256_email_address: email } : {}),
    ...(phone ? { sha256_phone_number: phone } : {}),
  };
}

export function buildGoogleViewItem(input: {
  slug: string;
  price?: number;
  name?: string | null;
}): GoogleEvent | null {
  const itemId = resolveContentId({ slug: input.slug });
  if (!itemId) return null;

  return {
    name: "view_item",
    params: {
      currency: GOOGLE_CURRENCY,
      ...(isPositive(input.price) ? { value: money(input.price) } : {}),
      items: [
        {
          item_id: itemId,
          ...(input.name ? { item_name: input.name } : {}),
          ...(isPositive(input.price) ? { price: money(input.price) } : {}),
        },
      ],
    },
    dedupeKey: null,
  };
}

export function buildGoogleAddToCart(input: {
  slug: string;
  price?: number;
  quantity?: number;
  name?: string | null;
}): GoogleEvent | null {
  const itemId = resolveContentId({ slug: input.slug });
  if (!itemId) return null;

  const quantity = countOf(input.quantity);
  const price = isPositive(input.price) ? money(input.price) : undefined;

  return {
    name: "add_to_cart",
    params: {
      currency: GOOGLE_CURRENCY,
      ...(price !== undefined ? { value: money(price * quantity) } : {}),
      items: [
        {
          item_id: itemId,
          ...(input.name ? { item_name: input.name } : {}),
          quantity,
          ...(price !== undefined ? { price } : {}),
        },
      ],
    },
    dedupeKey: null,
  };
}

export function buildGoogleBeginCheckout(input: {
  value: number;
  items: { slug: string; quantity?: number; price?: number; name?: string | null }[];
}): GoogleEvent | null {
  const value = money(input.value);
  if (!isPositive(value)) return null;

  const items = input.items
    .map((item) => {
      const itemId = resolveContentId({ slug: item.slug });
      if (!itemId) return null;
      return {
        item_id: itemId,
        ...(item.name ? { item_name: item.name } : {}),
        quantity: countOf(item.quantity),
        ...(isPositive(item.price) ? { price: money(item.price) } : {}),
      };
    })
    .filter((item): item is GoogleItem => item !== null);

  if (items.length === 0) return null;

  return {
    name: "begin_checkout",
    params: { value, currency: GOOGLE_CURRENCY, items },
    dedupeKey: null,
  };
}

/**
 * The one event that represents money.
 *
 * Returns null unless the order is paid AND a positive amount actually settled.
 * Both conditions matter: a pending, failed, abandoned or manual-payment order
 * has `isPaid === false`, and a zero-value "purchase" is either a bug or a
 * fully-discounted order that Google should not learn revenue from.
 */
export function buildGooglePurchase(
  order: PaidOrder,
  options?: { identity?: GoogleIdentity | null },
): GoogleEvent | null {
  if (!order.orderId) return null;
  if (!order.isPaid) return null;
  const value = money(order.amountPaid);
  if (!isPositive(value)) return null;

  // A product name is not an identifier and never becomes one here. It is not
  // stable, it is not what the other three events send, and using it would
  // produce an item id that silently stops matching the day a product is
  // renamed. A line with no slug and no product id is dropped instead.
  const resolved = order.items
    .map((item) => {
      const itemId = resolveContentId({ slug: item.slug, productId: item.productId });
      if (!itemId) return null;
      return {
        item_id: itemId,
        ...(item.productName ? { item_name: item.productName } : {}),
        quantity: countOf(item.quantity),
        ...(isPositive(item.unitPrice) ? { price: money(item.unitPrice) } : {}),
      };
    })
    .filter((item): item is GoogleItem => item !== null);

  // A purchase always carries an item, even when no line resolved. Dropping the
  // event would cost the whole conversion; identifying the order itself costs
  // nothing and is legible as the anomaly it is if it ever appears.
  const items: GoogleItem[] =
    resolved.length > 0
      ? resolved
      : [{ item_id: `order-${order.orderId}`, item_name: "Order (line items unresolved)", quantity: 1, price: value }];

  const userData = userDataFrom(options?.identity);

  return {
    name: "purchase",
    params: {
      value,
      currency: GOOGLE_CURRENCY,
      transaction_id: order.orderId,
      items,
    },
    ...(userData ? { userData } : {}),
    dedupeKey: `google-purchase:${order.orderId}`,
  };
}

export type GoogleEmitter = (name: GoogleEventName, params: Record<string, unknown>) => void;

/** Send an event, honouring its dedupe key. Mirrors emitSnapEvent. */
export function emitGoogleEvent(
  event: GoogleEvent | null,
  emit: GoogleEmitter,
  store: { has(key: string): boolean; mark(key: string): void },
): boolean {
  if (!event) return false;
  if (event.dedupeKey && store.has(event.dedupeKey)) return false;
  emit(event.name, event.params);
  if (event.dedupeKey) store.mark(event.dedupeKey);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd website && npx vitest run src/lib/ads/google-events.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Add the mutation controls**

These prove the gates are load-bearing rather than decorative. Append to `google-events.test.ts`:

```ts
describe("mutation controls — these must fail if the guard is deleted", () => {
  it("the isPaid check is load-bearing: an unpaid order with every other field valid reports nothing", () => {
    const unpaid: PaidOrder = { ...paidOrder, isPaid: false };
    expect(buildGooglePurchase(unpaid)).toBeNull();
    // Deleting `if (!order.isPaid) return null;` makes this line fail.
  });

  it("transaction_id is derived, not generated: two builds of one order agree", () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => buildGooglePurchase(paidOrder)?.params.transaction_id),
    );
    expect(ids.size).toBe(1);
    // Replacing transaction_id with a uuid or timestamp makes this line fail.
  });

  it("hashedOnly is load-bearing: identity that is not a digest produces no userData", () => {
    const event = buildGooglePurchase(paidOrder, {
      identity: { hashedEmail: "person@example.com", hashedPhone: "+15550101234" },
    });
    expect(event?.userData).toBeUndefined();
    // Removing the hashedOnly filter makes this line fail.
  });
});
```

- [ ] **Step 6: Run the whole ads suite**

Run: `cd website && npx vitest run src/lib/ads/`
Expected: PASS. Every pre-existing TikTok, Snap and Reddit test still passes, unmodified.

- [ ] **Step 7: Commit**

```bash
git add website/src/lib/ads/google-events.ts website/src/lib/ads/google-events.test.ts
git commit -m "feat(ads): pure Google Ads event builders

Five events built from the same PaidOrder, the same catalogue slugs and
the same settled figures the other three channels use. Purchase returns
null unless the backend says paid and a positive amount settled.

Shipping and tax are deliberately not sent: PaidOrder carries neither,
and producing them would mean a second pricing calculation. value is the
settled total, inclusive of both by construction."
```

---

### Task 4: The consent-gated browser pixel

**Files:**
- Create: `website/src/components/google-pixel.tsx`
- Create: `website/src/lib/ads/google-health-browser.ts`
- Modify: `website/src/app/layout.tsx:23-25` (imports), `website/src/app/layout.tsx:254-256` (mount)
- Test: `website/src/lib/ads/google-pixel-source.test.ts`

**Interfaces:**
- Consumes: `GOOGLE_ADS_ID`, `isConfiguredGoogleAdsId` from `@/lib/ads/google-conversion-id`; `browserAdsReportingAllowed` from `@/lib/ads/ads-environment`.
- Produces: `GooglePixel` React component; `countGooglePageView(): void`, `readGooglePageViews(): number` from `google-health-browser`.

Mirrors `snap-pixel.tsx` structurally, including starting both state flags `false` so the safe answer survives a hydration failure.

- [ ] **Step 1: Write the failing source-invariant test**

Create `website/src/lib/ads/google-pixel-source.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Google pixel.
 *
 * These are assertions about the source itself because the failures they catch
 * do not show up in a unit test of any individual module: a consent gate
 * deleted during a refactor, an environment guard removed as "redundant", or
 * Google's placeholder identity string left in the config object.
 */
const PIXEL = join(process.cwd(), "src/components/google-pixel.tsx");
const source = () => readFileSync(PIXEL, "utf8");

describe("google-pixel.tsx invariants", () => {
  it("consults the consent state", () => {
    expect(source()).toContain("vl_cookie_consent");
  });

  it("consults the environment guard", () => {
    expect(source()).toContain("browserAdsReportingAllowed");
  });

  it("checks the conversion id is really a Google Ads id", () => {
    expect(source()).toContain("isConfiguredGoogleAdsId");
  });

  it("carries no raw identity field in the gtag config", () => {
    const text = source();
    expect(text).not.toContain("INSERT_USER_EMAIL");
    expect(text).not.toMatch(/['"]email['"]\s*:/);
    expect(text).not.toMatch(/user_data\s*:/);
  });

  it("declares no conversion id of its own", () => {
    expect(source()).not.toMatch(/["'`]AW-\d+["'`]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-pixel-source.test.ts`
Expected: FAIL — ENOENT, `src/components/google-pixel.tsx` does not exist.

- [ ] **Step 3: Write the page-view counter**

Create `website/src/lib/ads/google-health-browser.ts`:

```ts
/**
 * A browser-side tally of Google page views.
 *
 * The gtag call goes into a vendor queue and leaves nothing behind to inspect,
 * so the admin health board has no other way to know a page view happened.
 * Mirrors snap-health-browser.ts.
 */
const KEY = "vl_google_pageviews";

export function countGooglePageView(): void {
  try {
    const current = Number(window.sessionStorage.getItem(KEY) ?? "0");
    window.sessionStorage.setItem(KEY, String((Number.isFinite(current) ? current : 0) + 1));
  } catch {
    /* storage blocked; the tally is diagnostics, never a gate */
  }
}

export function readGooglePageViews(): number {
  try {
    const current = Number(window.sessionStorage.getItem(KEY) ?? "0");
    return Number.isFinite(current) ? current : 0;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Write the pixel component**

Create `website/src/components/google-pixel.tsx`:

```tsx
"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { browserAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_ID, isConfiguredGoogleAdsId } from "@/lib/ads/google-conversion-id";
import { countGooglePageView } from "@/lib/ads/google-health-browser";

/**
 * Google Ads global site tag — installed globally, behind the same consent gate
 * as everything else.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * It is NOT hard-coded into <head> unconditionally, and that is deliberate.
 * Dropping a third-party advertising script before consent is the single most
 * common finding in a cookie audit, and the banner promises Decline is a real
 * no-track path. Gating it here means the tag is never fetched for someone who
 * declined — no request to googletagmanager.com, no cookie, nothing to revoke.
 *
 * THE THIRD GATE IS THE CONVERSION ID ITSELF. Unlike the other three pixels,
 * this one has no production fallback value, so an unconfigured deployment
 * renders nothing at all. That is what lets this component ship before the
 * Google Ads account exists.
 *
 * ON THE CONFIG OBJECT: Google's own setup guides put `'user_data'` or an
 * `email` field in this position. Both are omitted deliberately. Left as a
 * placeholder it sends a literal string to Google as the visitor's identity on
 * every page load; filled in, it sends a raw address to a third party on every
 * page view. The root layout does not know who the visitor is in any case.
 * Identity is attached at exactly one point — a confirmed paid order — and only
 * ever as a SHA-256 digest produced on the server. See google-events.ts.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

function hasAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "accepted";
  } catch {
    // Storage blocked (private mode, some in-app browsers). Absence of a
    // recorded "yes" is a no.
    return false;
  }
}

export function GooglePixel() {
  const [accepted, setAccepted] = useState(false);
  /**
   * Consent is necessary and NOT sufficient: a preview deployment, a local run,
   * a CI job or a Playwright script must never reach the live ad account. See
   * src/lib/ads/ads-environment.ts.
   *
   * Resolved in an effect rather than during render, and starting FALSE, because
   * two of its inputs (location.hostname, navigator.webdriver) exist only in the
   * browser, so deciding during render would make the server and the client
   * disagree and React would hydrate onto different markup. Starting closed also
   * means the safe answer is the one that survives a hydration failure.
   */
  const [adsAllowed, setAdsAllowed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAdsAllowed(browserAdsReportingAllowed().allowed);
  }, []);

  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The inline snippet's own config call reports the first page view. Skipping
  // that first route-change effect avoids double-counting the landing page.
  const initialPageSent = useRef(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAccepted());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // A single-page app: after the first load, navigation never reloads the
  // document, so without this every visit would report exactly one page view
  // however much of the site someone read.
  useEffect(() => {
    if (!adsAllowed || !accepted || !isConfiguredGoogleAdsId(GOOGLE_ADS_ID)) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      countGooglePageView();
      return;
    }
    window.gtag?.("event", "page_view");
    countGooglePageView();
  }, [adsAllowed, accepted, pathname, searchParams]);

  if (!adsAllowed) return null;
  if (!accepted) return null;
  if (!isConfiguredGoogleAdsId(GOOGLE_ADS_ID)) return null;

  return (
    <>
      <Script id="google-tag-loader" strategy="afterInteractive" src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`} />
      <Script id="google-tag-config" strategy="afterInteractive">
        {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GOOGLE_ADS_ID}');
        `}
      </Script>
    </>
  );
}
```

- [ ] **Step 5: Run the invariant test**

Run: `cd website && npx vitest run src/lib/ads/google-pixel-source.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Mount it in the root layout**

In `website/src/app/layout.tsx`, add beside the existing pixel imports (around line 25):

```tsx
import { GooglePixel } from "@/components/google-pixel";
```

And beside the existing mounts (around line 256), after `<RedditPixel />`:

```tsx
          <GooglePixel />
```

- [ ] **Step 7: Verify the build and lint pass**

Run: `cd website && npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add website/src/components/google-pixel.tsx website/src/lib/ads/google-health-browser.ts website/src/lib/ads/google-pixel-source.test.ts website/src/app/layout.tsx
git commit -m "feat(ads): consent-gated Google Ads global site tag

Three gates, all of which must pass before a request reaches
googletagmanager.com: recorded consent, the production environment
guard, and a conversion id that is really an AW- id. The third means
this ships inert until the account exists.

No identity field in the config object. Identity is attached once, on a
confirmed paid order, as a server-produced digest."
```

---

### Task 5: Per-platform send ledger

> **CHECKPOINT — STOP AND GET APPROVAL BEFORE STARTING THIS TASK.**
> This is the only task that changes behaviour for the existing audited
> channels, and it alters a table already applied to production. The spec
> (§2.1, §7) explains why it is unavoidable. Do not begin until the owner
> has approved the migration.

**Files:**
- Create: `website/src/lib/sql/ads-purchase-ledger-per-platform.sql`
- Modify: `website/src/app/api/ads/purchase-event/[orderId]/route.ts:208-218` (the `alreadySent` read), `:310-323` (the ledger write)
- Test: `website/src/lib/ads/purchase-ledger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type LedgerPlatform = "tiktok" | "reddit" | "google"`, `wasAlreadySent(rows, platform): boolean`.

**The defect being fixed.** `ad_purchase_events_sent` has `order_id` as its PRIMARY KEY, so there is one row per order shared by every channel. That single row is read once into `alreadySent`, which gates both the Reddit and TikTok sends — but it is only ever *written* inside the TikTok block. Today that means: with Reddit credentials present and TikTok's absent, no row is ever written and Reddit's permanent idempotency silently does not apply. Adding Google to the shared gate would make "one paid order, one Google conversion" untrue by construction.

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/purchase-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wasAlreadySent, type LedgerRow } from "./purchase-ledger";

const rows: LedgerRow[] = [
  { order_id: "VL-1001", platform: "tiktok", delivered: true },
  { order_id: "VL-1001", platform: "reddit", delivered: true },
];

describe("wasAlreadySent", () => {
  it("reports a platform that has already sent", () => {
    expect(wasAlreadySent(rows, "tiktok")).toBe(true);
  });

  it("does NOT suppress a platform that has not sent, just because another has", () => {
    expect(wasAlreadySent(rows, "google")).toBe(false);
  });

  it("treats a recorded-but-undelivered attempt as sent, so a hard rejection is not retried on every refresh", () => {
    expect(wasAlreadySent([{ order_id: "VL-1", platform: "google", delivered: false }], "google")).toBe(true);
  });

  it("reports nothing sent when the ledger is unavailable", () => {
    expect(wasAlreadySent([], "google")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/purchase-ledger.test.ts`
Expected: FAIL — "Failed to resolve import ./purchase-ledger".

- [ ] **Step 3: Write the helper**

Create `website/src/lib/ads/purchase-ledger.ts`:

```ts
/**
 * The purchase send-ledger, read per platform.
 *
 * Originally one row per order, shared by every channel, written only by the
 * TikTok block but gating Reddit's send too. Two consequences, both live:
 * with Reddit configured and TikTok not, no row was ever written and Reddit's
 * permanent idempotency did not apply; and whichever platform wrote first
 * marked the order sent for all of them.
 *
 * Keyed on (order_id, platform), each channel answers only for itself.
 */
export type LedgerPlatform = "tiktok" | "reddit" | "google";

export type LedgerRow = {
  order_id: string;
  platform: string;
  delivered: boolean;
};

/**
 * Has this platform already reported this order?
 *
 * A recorded-but-undelivered row counts as sent. That is deliberate and carries
 * over from the original: a hard platform rejection must not be retried on
 * every confirmation-page refresh. `delivered` distinguishes the two for later
 * repair.
 */
export function wasAlreadySent(rows: LedgerRow[], platform: LedgerPlatform): boolean {
  return rows.some((row) => row.platform === platform);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd website && npx vitest run src/lib/ads/purchase-ledger.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the migration**

Create `website/src/lib/sql/ads-purchase-ledger-per-platform.sql`:

```sql
-- =============================================================================
-- Purchase send-ledger — one row per (order, platform).
--
-- NOT YET APPLIED. Additive and reversible; apply during a quiet period.
--
-- WHY. ads-purchase-idempotency.sql made order_id the PRIMARY KEY, so there is
-- one row per order shared by every channel. The route reads it once into
-- `alreadySent` and uses it to gate both the Reddit and the TikTok send, but
-- writes it only inside the TikTok block. Two live consequences:
--
--   * Reddit configured, TikTok not: no row is ever written, so Reddit's
--     permanent idempotency silently does not apply.
--   * Whichever platform writes first marks the order sent for all of them.
--
-- A fourth channel makes this unworkable rather than merely wrong: Google's
-- send would be suppressed by TikTok's, or would suppress it.
--
-- BACKFILL IS A NO-OP BY CONSTRUCTION. Existing rows already carry
-- platform = 'tiktok' (its column default), which is historically accurate:
-- those sends were TikTok's.
-- =============================================================================

alter table public.ad_purchase_events_sent
  drop constraint if exists ad_purchase_events_sent_pkey;

alter table public.ad_purchase_events_sent
  add constraint ad_purchase_events_sent_pkey
  primary key (order_id, platform);

create index if not exists ad_purchase_events_sent_order_idx
  on public.ad_purchase_events_sent (order_id);

comment on table public.ad_purchase_events_sent is
  'One row per (order, platform) whose Purchase has been reported server-side. Prevents a re-opened confirmation link from creating a second conversion after a platform''s own dedup window closes, and lets each channel answer only for itself.';
```

- [ ] **Step 6: Update the route's read**

In `website/src/app/api/ads/purchase-event/[orderId]/route.ts`, replace the `alreadySent` block (around lines 208-218) with:

```ts
  let ledgerRows: LedgerRow[] = [];
  try {
    const { data: sent } = await supabaseAdmin
      .from("ad_purchase_events_sent")
      .select("order_id, platform, delivered")
      .eq("order_id", String(order.order_id));
    ledgerRows = (sent ?? []) as LedgerRow[];
  } catch {
    /* table not applied yet — fall through and send */
  }
  const alreadySent = wasAlreadySent(ledgerRows, "tiktok");
  const redditAlreadySent = wasAlreadySent(ledgerRows, "reddit");
```

Add to the imports at the top of the file:

```ts
import { wasAlreadySent, type LedgerRow } from "@/lib/ads/purchase-ledger";
```

Change the Reddit send's gate from `!alreadySent` to `!redditAlreadySent`.

- [ ] **Step 7: Give Reddit its own ledger write**

Inside the Reddit block, immediately after `redditDelivery = describeRedditResult(redditOutcome);`, add:

```ts
    // Reddit records its own send. Previously only TikTok wrote a row, so with
    // TikTok unconfigured this ledger stayed empty and Reddit re-sent on every
    // confirmation-page load once its own dedup window closed.
    try {
      await supabaseAdmin.from("ad_purchase_events_sent").upsert(
        {
          order_id: String(order.order_id),
          event_id: redditPurchase.properties.conversionId ?? String(order.order_id),
          platform: "reddit",
          delivered: redditOutcome.delivered,
        },
        { onConflict: "order_id,platform" },
      );
    } catch {
      /* ledger unavailable; Reddit's own dedup window still applies */
    }
```

- [ ] **Step 8: Update TikTok's ledger write**

Change the existing upsert's conflict target only — leave every other field as it is:

```ts
        { onConflict: "order_id,platform" },
```

- [ ] **Step 9: Verify nothing about the existing channels changed**

Run: `cd website && npx vitest run src/lib/ads/ && npm run lint && npx tsc --noEmit`
Expected: PASS. Every TikTok, Snap and Reddit test passes unmodified.

- [ ] **Step 10: Commit**

```bash
git add website/src/lib/ads/purchase-ledger.ts website/src/lib/ads/purchase-ledger.test.ts website/src/lib/sql/ads-purchase-ledger-per-platform.sql "website/src/app/api/ads/purchase-event/[orderId]/route.ts"
git commit -m "fix(ads): key the purchase send-ledger on (order, platform)

The ledger had order_id as its primary key and was written only inside
the TikTok block, while gating Reddit's send too. With Reddit configured
and TikTok not, no row was written and Reddit's permanent idempotency
silently did not apply.

Each channel now answers only for itself, which is also what makes one
paid order produce exactly one conversion per platform once Google is
added. Migration is additive; existing rows already carry platform
'tiktok', which is historically accurate."
```

---

### Task 6: Wire Google into the purchase route

**Files:**
- Modify: `website/src/app/api/ads/purchase-event/[orderId]/route.ts` (imports; after the `redditPurchase` block; the `inspect` response; the final response)
- Test: `website/src/lib/ads/google-route-contract.test.ts`

**Interfaces:**
- Consumes: `buildGooglePurchase` (Task 3), `buildGoogleIdentity` (Task 2), `wasAlreadySent` (Task 5).
- Produces: a `googlePurchase` field on both the `inspect` and the normal route responses.

The Google purchase is built from the **same** `paidOrder` object the other three use. There is exactly one place on this page that decides a purchase happened, and a fourth ad network must not add a fourth opinion about it.

- [ ] **Step 1: Write the failing contract test**

Create `website/src/lib/ads/google-route-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract assertions about the purchase route.
 *
 * The route needs a database and a request to run, so these assert the
 * structural properties that matter about its source: that Google is built
 * from the shared paid order, and that it does not acquire an independent
 * opinion about whether a purchase happened.
 */
const ROUTE = join(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts");
const source = () => readFileSync(ROUTE, "utf8");

describe("purchase route — Google wiring", () => {
  it("builds the Google purchase from the shared paidOrder object", () => {
    expect(source()).toMatch(/buildGooglePurchase\(\s*paidOrder/);
  });

  it("does not re-read payment_status for Google", () => {
    const occurrences = source().match(/payment_status/g) ?? [];
    // The order query, the isPaid derivation, and the two diagnostic strings.
    expect(occurrences.length).toBeLessThanOrEqual(4);
  });

  it("gates the Google send on its own ledger entry, not another platform's", () => {
    expect(source()).toMatch(/wasAlreadySent\(ledgerRows,\s*["']google["']\)/);
  });

  it("gates the Google send on its own credential check", () => {
    expect(source()).toMatch(/googleCredentialStatus\(\)\.configured/);
  });

  it("returns the Google purchase for the confirmation page to emit", () => {
    expect(source()).toContain("googlePurchase");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-route-contract.test.ts`
Expected: FAIL — the route contains no `buildGooglePurchase`.

- [ ] **Step 3: Add the imports**

At the top of the route, beside the existing builder imports:

```ts
import { buildGooglePurchase } from "@/lib/ads/google-events";
import { buildGoogleIdentity } from "@/lib/ads/google-matching";
import { describeGoogleResult, googleCredentialStatus, sendGoogleConversion } from "@/lib/ads/google-conversions";
```

> `google-conversions` is built in Task 7. If executing tasks strictly in order, stub the three imports as no-ops returning `{ configured: false }` / `null`, and complete them in Task 7. The contract test's credential assertion will pass either way.

- [ ] **Step 4: Build the Google purchase**

Immediately after the existing `redditPurchase` block, add:

```ts
  // Google, from the SAME server-confirmed paid gate. Its identity uses
  // Google's own canonicalisation — Gmail dots and +suffixes stripped, phone in
  // E.164 with the plus — which is why it is hashed here rather than reusing
  // the digests TikTok and Snap receive. transaction_id is the order id, the
  // identical value the browser tag sends, so Google collapses the pair into
  // one conversion rather than doubling the reported revenue.
  const googleIdentity = buildGoogleIdentity({
    email: order.customer_email ? String(order.customer_email) : null,
    phone: orderPhone,
  });
  const googlePurchase = buildGooglePurchase(paidOrder, { identity: googleIdentity });
```

- [ ] **Step 5: Send it, on its own gates**

After the Reddit send block and before the TikTok one, add:

```ts
  let googleDelivery: string | null = null;

  // Google, on its OWN credential and ledger checks — deliberately not nested
  // inside TikTok's or Reddit's. Nesting is a silent single point of failure:
  // one platform unconfigured would stop another's conversions while every
  // dashboard looked fine. Four platforms, four independent gates.
  if (googlePurchase && !wasAlreadySent(ledgerRows, "google") && googleCredentialStatus().configured) {
    const googleOutcome = await sendGoogleConversion({
      event: googlePurchase,
      occurredAt: new Date(),
    });
    googleDelivery = describeGoogleResult(googleOutcome);
    if (!googleOutcome.delivered) {
      console.error("[ads/google-conversions]", googleDelivery);
    }

    try {
      await supabaseAdmin.from("ad_purchase_events_sent").upsert(
        {
          order_id: String(order.order_id),
          event_id: googlePurchase.params.transaction_id ?? String(order.order_id),
          platform: "google",
          delivered: googleOutcome.delivered,
        },
        { onConflict: "order_id,platform" },
      );
    } catch {
      /* ledger unavailable; Google's own transaction_id dedup still applies */
    }
  }
```

- [ ] **Step 6: Add it to both responses**

In the `inspect` response object, beside `snapPurchase` and `redditPurchase`:

```ts
        googlePurchase,
        googleConfigured: googleCredentialStatus().configured,
```

In the final response object:

```ts
    { found: true, isPaid, event, snapPurchase, redditPurchase, googlePurchase, serverDelivery: [serverDelivery, redditDelivery, googleDelivery].filter(Boolean).join(" | ") || null },
```

- [ ] **Step 7: Run the contract test and the suite**

Run: `cd website && npx vitest run src/lib/ads/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "website/src/app/api/ads/purchase-event/[orderId]/route.ts" website/src/lib/ads/google-route-contract.test.ts
git commit -m "feat(ads): build and send the Google purchase from the shared paid order

Four platforms, one PaidOrder, read once. Google gets independent
credential and ledger gates rather than being nested inside TikTok's or
Reddit's, which would be a silent single point of failure."
```

---

### Task 7: The Enhanced Conversions server leg

**Files:**
- Create: `website/src/lib/ads/google-conversions.ts`
- Test: `website/src/lib/ads/google-conversions.test.ts`

**Interfaces:**
- Consumes: `serverAdsReportingAllowed` from `./ads-environment`; `type GoogleEvent` from `./google-events`; `GOOGLE_ADS_ID`, `GOOGLE_PURCHASE_LABEL` from `./google-conversion-id`.
- Produces: `googleCredentialStatus(): { configured: boolean; missing: string[] }`, `sendGoogleConversion(input): Promise<GoogleSendResult>`, `describeGoogleResult(result): string`, `type GoogleSendResult = { attempted: boolean; delivered: boolean; code: number | null; message: string | null }`.

Fails closed on **partial** configuration: an incomplete credential set must never produce a partially-identified conversion.

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/google-conversions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

function setAll(value: string | undefined) {
  for (const key of ENV_KEYS) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("googleCredentialStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll(undefined);
  });
  afterEach(() => setAll(undefined));

  it("is not configured with no credentials at all", async () => {
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(false);
  });

  it("is configured when every credential is present", async () => {
    setAll("value");
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(true);
  });

  it("FAILS CLOSED on partial configuration and names what is missing", async () => {
    setAll("value");
    delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const { googleCredentialStatus } = await import("./google-conversions");
    const status = googleCredentialStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("GOOGLE_ADS_REFRESH_TOKEN");
  });

  it("treats an empty string as absent, not as a credential", async () => {
    setAll("value");
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "   ";
    const { googleCredentialStatus } = await import("./google-conversions");
    expect(googleCredentialStatus().configured).toBe(false);
  });
});

describe("sendGoogleConversion", () => {
  beforeEach(() => {
    vi.resetModules();
    setAll(undefined);
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    setAll(undefined);
    vi.unstubAllGlobals();
  });

  it("sends nothing when unconfigured, and says so rather than throwing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date("2026-08-27T12:00:00Z"),
    });
    expect(result.attempted).toBe(false);
    expect(result.delivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing on partial configuration", async () => {
    setAll("value");
    delete process.env.GOOGLE_ADS_CLIENT_SECRET;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("describeGoogleResult", () => {
  it("cannot leak a credential, because it has no field to carry one", async () => {
    const { describeGoogleResult } = await import("./google-conversions");
    const text = describeGoogleResult({
      attempted: true,
      delivered: false,
      code: 401,
      message: "UNAUTHENTICATED",
    });
    expect(text).toContain("401");
    expect(text).not.toContain("GOOGLE_ADS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-conversions.test.ts`
Expected: FAIL — "Failed to resolve import ./google-conversions".

- [ ] **Step 3: Write the implementation**

Create `website/src/lib/ads/google-conversions.ts`:

```ts
import "server-only";

import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { GOOGLE_ADS_ID, GOOGLE_PURCHASE_LABEL } from "@/lib/ads/google-conversion-id";
import type { GoogleEvent } from "@/lib/ads/google-events";

/**
 * Google Ads Enhanced Conversions — the server-side leg.
 *
 * WHY IT EXISTS. The browser tag is the only path today, and a meaningful share
 * of it never arrives: ad blockers, tracking-protection defaults, a tab closed
 * before the request flushes. This reports the same purchase from the server,
 * where none of that applies. Both legs carry the same `transaction_id`, so
 * Google counts ONE conversion.
 *
 * IT FAILS CLOSED ON PARTIAL CONFIGURATION, and that is the important property
 * here. Five separate values are needed; a half-configured integration that
 * attempted the call anyway would produce either an error on every paid order
 * or, worse, a conversion carrying incomplete identity. Absence of a complete
 * credential set is a refusal, not a best-effort attempt.
 *
 * ITS CREDENTIAL CHECK IS INDEPENDENT of TikTok's and Reddit's. Nesting Reddit
 * inside TikTok's was a real silent single point of failure — with one token
 * configured and the other absent, the whole block was skipped and conversions
 * never sent while every dashboard looked fine. Four platforms, four gates.
 *
 * ON DIAGNOSTICS. `describeGoogleResult` is built from a fixed field set
 * precisely so a token, a customer id or a customer's data cannot reach a log
 * line, a Sentry breadcrumb or the audit log. It has no field to carry one.
 */

const REQUIRED_ENV = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

export type GoogleSendResult = {
  attempted: boolean;
  delivered: boolean;
  code: number | null;
  message: string | null;
};

function present(key: string): boolean {
  return String(process.env[key] ?? "").trim().length > 0;
}

/**
 * Every credential, or none. `missing` names what to set rather than making an
 * operator diff two lists by hand.
 */
export function googleCredentialStatus(): { configured: boolean; missing: string[] } {
  const missing = REQUIRED_ENV.filter((key) => !present(key));
  return { configured: missing.length === 0, missing };
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_API_BASE = "https://googleads.googleapis.com/v18/customers";

async function accessToken(): Promise<string | null> {
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: String(process.env.GOOGLE_ADS_CLIENT_ID),
        client_secret: String(process.env.GOOGLE_ADS_CLIENT_SECRET),
        refresh_token: String(process.env.GOOGLE_ADS_REFRESH_TOKEN),
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Report one purchase.
 *
 * Best-effort telemetry by contract: it never throws, because the caller is a
 * customer's confirmation page and a measurement failure must not become a
 * customer-visible one.
 */
export async function sendGoogleConversion(input: {
  event: GoogleEvent;
  occurredAt: Date;
}): Promise<GoogleSendResult> {
  const notAttempted: GoogleSendResult = { attempted: false, delivered: false, code: null, message: null };

  if (!googleCredentialStatus().configured) {
    return { ...notAttempted, message: "credentials incomplete" };
  }

  // The one gate that decides whether an ad event may leave this deployment.
  // A preview, a local run, CI or a Playwright script must never train the real
  // account. Deny by default; there is deliberately no override.
  const verdict = serverAdsReportingAllowed();
  if (!verdict.allowed) {
    return { ...notAttempted, message: `suppressed: ${verdict.reason ?? "not production"}` };
  }

  const transactionId = input.event.params.transaction_id;
  if (!transactionId) return { ...notAttempted, message: "no transaction id" };

  const token = await accessToken();
  if (!token) return { ...notAttempted, message: "oauth refresh failed" };

  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, "");

  try {
    const response = await fetch(`${ADS_API_BASE}/${customerId}:uploadClickConversions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "developer-token": String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversions: [
          {
            conversionAction: `customers/${customerId}/conversionActions/${GOOGLE_PURCHASE_LABEL}`,
            conversionDateTime: formatGoogleDateTime(input.occurredAt),
            conversionValue: input.event.params.value,
            currencyCode: input.event.params.currency,
            orderId: transactionId,
            ...(input.event.userData
              ? {
                  userIdentifiers: [
                    ...(input.event.userData.sha256_email_address
                      ? [{ hashedEmail: input.event.userData.sha256_email_address }]
                      : []),
                    ...(input.event.userData.sha256_phone_number
                      ? [{ hashedPhoneNumber: input.event.userData.sha256_phone_number }]
                      : []),
                  ],
                }
              : {}),
          },
        ],
        partialFailure: true,
      }),
    });

    return {
      attempted: true,
      delivered: response.ok,
      code: response.status,
      message: response.ok ? null : response.statusText,
    };
  } catch {
    return { attempted: true, delivered: false, code: null, message: "network error" };
  }
}

/** Google wants `yyyy-MM-dd HH:mm:ss+|-HH:mm`, not ISO-8601. */
export function formatGoogleDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

/**
 * A fixed field set. No token, no customer id, no customer data — this is what
 * makes it safe to log.
 */
export function describeGoogleResult(result: GoogleSendResult): string {
  if (!result.attempted) return `google: not sent (${result.message ?? "not attempted"})`;
  if (result.delivered) return "google: delivered";
  return `google: rejected (${result.code ?? "no status"}${result.message ? ` ${result.message}` : ""})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd website && npx vitest run src/lib/ads/google-conversions.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the environment mutation control**

Append to `google-conversions.test.ts`:

```ts
describe("environment enforcement — mutation control", () => {
  it("refuses to send from a non-production environment even fully credentialed", async () => {
    vi.resetModules();
    setAll("value");
    process.env.VERCEL_ENV = "preview";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1", value: 10, currency: "USD" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(result.message).toMatch(/suppressed/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Deleting the serverAdsReportingAllowed() call makes this fail.
    delete process.env.VERCEL_ENV;
  });

  it("refuses when VERCEL_ENV is unset, because 'we could not tell' is not 'production'", async () => {
    vi.resetModules();
    setAll("value");
    delete process.env.VERCEL_ENV;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { sendGoogleConversion } = await import("./google-conversions");
    const result = await sendGoogleConversion({
      event: { name: "purchase", params: { transaction_id: "VL-1", value: 10, currency: "USD" }, dedupeKey: null },
      occurredAt: new Date(),
    });
    expect(result.attempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Add the secret-exposure assertion**

In `website/src/lib/ads/single-data-source.test.ts`, extend the existing secret check to cover the Google names by adding them to whatever list `findClientExposedSecrets` consults in `tracking-health-server.ts`. Read that function first and follow its existing shape rather than adding a parallel mechanism — one helper stays the single answer to "did a secret reach the browser".

- [ ] **Step 7: Correct the now-stale gate comment**

`ads-environment.ts`'s header currently ends: *"NOTE ON META: there is no
Meta/Facebook pixel in this codebase, and no Snap Conversions API server leg.
This gate is the chokepoint any future one must pass through, which is the point
of having exactly one."*

Google is now such a future one, and a map that no longer matches the ground is
worse than no map. Add one clause — do not rewrite the paragraph:

```
 * NOTE ON META: there is no Meta/Facebook pixel in this codebase, and no Snap
 * Conversions API server leg. Google Ads has both legs, and both pass through
 * here — the browser tag via browserAdsReportingAllowed in google-pixel.tsx,
 * the Enhanced Conversions leg via serverAdsReportingAllowed in
 * google-conversions.ts. This gate is the chokepoint any future one must pass
 * through, which is the point of having exactly one.
```

Change nothing else in the file. Its logic is not in scope.

- [ ] **Step 8: Run the full suite, lint and typecheck**

Run: `cd website && npm test && npm run lint && npx tsc --noEmit`
Expected: PASS. `ads-environment.test.ts` and
`ads-environment-enforcement.test.ts` must pass unmodified — if either needed a
change, the comment edit touched logic and must be reverted.

- [ ] **Step 9: Commit**

```bash
git add website/src/lib/ads/ads-environment.ts website/src/lib/ads/google-conversions.ts website/src/lib/ads/google-conversions.test.ts website/src/lib/ads/tracking-health-server.ts website/src/lib/ads/single-data-source.test.ts
git commit -m "feat(ads): Enhanced Conversions server leg, failing closed

Five credentials or none: a partial set is a refusal, never a
best-effort call that would report a partially-identified conversion.
Its credential gate is independent of TikTok's and Reddit's.

Passes the same deny-by-default environment guard as every other
reporting path, with mutation tests that fail if the guard is removed."
```

---

### Task 8: Health rows and the narrow HealthTier fix

**Files:**
- Modify: `website/src/lib/ads/tracking-health.ts` (the `HealthTier` union and its 11 occurrences)
- Create: `website/src/lib/ads/google-health.ts`
- Test: `website/src/lib/ads/google-health.test.ts`

**Interfaces:**
- Consumes: `type HealthCheck`, `type HealthTier` from `./tracking-health`; `googleCredentialStatus` from `./google-conversions`.
- Produces: `type GoogleHealthState`, `buildGoogleHealth(input): HealthCheck[]`.

**Keep the tier refactor to exactly this:** rename the `"TIKTOK"` member to `"PLATFORM"` and name the platform in each row's `detail`. All 11 occurrences are inside `tracking-health.ts`. Existing TikTok, Snap and Reddit rows must render identical labels, statuses and details afterwards.

- [ ] **Step 1: Write the failing test**

Create `website/src/lib/ads/google-health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildGoogleHealth } from "./google-health";

const base = {
  conversionId: "",
  credentials: { configured: false, missing: ["GOOGLE_ADS_DEVELOPER_TOKEN"] },
  environmentAllowed: true,
  lastSend: null,
};

describe("buildGoogleHealth — the six states", () => {
  it("NOT_CONFIGURED with no conversion id, and does not call that an error", () => {
    const row = buildGoogleHealth(base)[0];
    expect(row.status).toBe("NOT_AVAILABLE");
    expect(row.detail).toMatch(/not configured/i);
  });

  it("BROWSER_CONFIGURED when the tag is live but the server leg is not credentialed", () => {
    const rows = buildGoogleHealth({ ...base, conversionId: "AW-123456789" });
    expect(rows.find((row) => row.id === "google-browser")?.status).toBe("PASS");
    expect(rows.find((row) => row.id === "google-server")?.status).toBe("NOT_AVAILABLE");
  });

  it("SERVER_INCOMPLETE names the missing variable rather than saying 'misconfigured'", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: false, missing: ["GOOGLE_ADS_REFRESH_TOKEN"] },
    }).find((r) => r.id === "google-server");
    expect(row?.detail).toContain("GOOGLE_ADS_REFRESH_TOKEN");
    expect(row?.action).toBeTruthy();
  });

  it("SUPPRESSED_BY_ENVIRONMENT is reported as working as designed, not as a failure", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      environmentAllowed: false,
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("NOT_AVAILABLE");
    expect(row?.detail).toMatch(/environment/i);
  });

  it("HEALTHY when configured, in production, and the last send delivered", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { delivered: true, code: 200, message: null },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("PASS");
  });

  it("ERROR carries Google's own status code", () => {
    const row = buildGoogleHealth({
      ...base,
      conversionId: "AW-123456789",
      credentials: { configured: true, missing: [] },
      lastSend: { delivered: false, code: 401, message: "UNAUTHENTICATED" },
    }).find((r) => r.id === "google-server");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail).toContain("401");
  });

  it("never marks a row PLATFORM-verified without a response from Google in hand", () => {
    const rows = buildGoogleHealth({ ...base, conversionId: "AW-123456789" });
    expect(rows.filter((row) => row.tier === "PLATFORM")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd website && npx vitest run src/lib/ads/google-health.test.ts`
Expected: FAIL — "Failed to resolve import ./google-health".

- [ ] **Step 3: Widen the tier**

In `website/src/lib/ads/tracking-health.ts`, change:

```ts
export type HealthTier = "CODE" | "PRODUCTION" | "PLATFORM";
```

Replace all 11 `"TIKTOK"` occurrences with `"PLATFORM"`, and in each affected row's `detail` name the platform explicitly (e.g. `"TikTok accepted the event"` rather than relying on the tier to say so). Update the file's header comment: the `TIKTOK —` line becomes `PLATFORM — the ad platform itself accepted or reported it; which one is named in the row's detail.`

- [ ] **Step 4: Prove the existing rows are unchanged**

Run: `cd website && npx vitest run src/lib/ads/tracking-health.test.ts`
Expected: PASS after updating only the tier literal in that test file. If any label, status or detail assertion needed changing, the refactor went too far — narrow it.

- [ ] **Step 5: Write the Google health builder**

Create `website/src/lib/ads/google-health.ts`:

```ts
import type { HealthCheck } from "./tracking-health";
import { isConfiguredGoogleAdsId } from "./google-conversion-id";

/**
 * Google's rows on the tracking health board.
 *
 * The board's discipline holds: a CODE row proves only what the repository
 * proves, and nothing is marked PLATFORM-verified without a response from
 * Google in hand. Six states, because "not working" collapses distinctions an
 * operator needs — an unconfigured account, a half-set credential list and a
 * deliberate environment suppression call for three different actions, and
 * exactly one of them is a bug.
 */
export type GoogleHealthInput = {
  conversionId: string;
  credentials: { configured: boolean; missing: string[] };
  environmentAllowed: boolean;
  lastSend: { delivered: boolean; code: number | null; message: string | null } | null;
};

export function buildGoogleHealth(input: GoogleHealthInput): HealthCheck[] {
  const browserConfigured = isConfiguredGoogleAdsId(input.conversionId);

  if (!browserConfigured) {
    return [
      {
        id: "google-browser",
        label: "Google Ads tag",
        tier: "CODE",
        status: "NOT_AVAILABLE",
        detail: "Not configured — NEXT_PUBLIC_GOOGLE_ADS_ID is unset, so the tag renders nothing.",
        action: "Set NEXT_PUBLIC_GOOGLE_ADS_ID once the Google Ads account and conversion action exist.",
      },
    ];
  }

  const rows: HealthCheck[] = [
    {
      id: "google-browser",
      label: "Google Ads tag",
      tier: "CODE",
      status: "PASS",
      detail: `Configured as ${input.conversionId}. Loads only after consent, and only in production.`,
    },
  ];

  if (!input.credentials.configured) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_AVAILABLE",
      detail:
        input.credentials.missing.length === 5
          ? "Server credentials not set. The browser tag reports on its own; the server leg is dark."
          : `Server credentials incomplete — missing ${input.credentials.missing.join(", ")}. Fails closed: nothing is sent.`,
      action:
        input.credentials.missing.length === 5
          ? "Apply for a Google Ads API developer token, then set the five GOOGLE_ADS_* variables."
          : `Set ${input.credentials.missing.join(", ")} in the production environment.`,
    });
    return rows;
  }

  if (!input.environmentAllowed) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_AVAILABLE",
      detail: "Fully credentialed, but reporting is suppressed by the environment guard. This is working as designed.",
      action: "No action. Only a production deployment reports.",
    });
    return rows;
  }

  if (!input.lastSend) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_TESTED",
      detail: "Credentialed and in production, but no conversion has been sent yet.",
      action: "Inspect a real paid order with ?inspect=1 to see the payload without sending it.",
    });
    return rows;
  }

  rows.push(
    input.lastSend.delivered
      ? {
          id: "google-server",
          label: "Enhanced Conversions (server)",
          tier: "PRODUCTION",
          status: "PASS",
          detail: `Last send delivered (HTTP ${input.lastSend.code ?? "200"}).`,
        }
      : {
          id: "google-server",
          label: "Enhanced Conversions (server)",
          tier: "PRODUCTION",
          status: "FAIL",
          detail: `Google rejected the last send: HTTP ${input.lastSend.code ?? "no status"}${input.lastSend.message ? ` ${input.lastSend.message}` : ""}.`,
          action: "Check the developer token's access level and the conversion action id.",
        },
  );

  return rows;
}
```

- [ ] **Step 6: Run tests**

Run: `cd website && npx vitest run src/lib/ads/`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add website/src/lib/ads/google-health.ts website/src/lib/ads/google-health.test.ts website/src/lib/ads/tracking-health.ts website/src/lib/ads/tracking-health.test.ts
git commit -m "feat(ads): Google health rows; widen HealthTier to PLATFORM

The TIKTOK tier already misdescribed Snap and Reddit rows. It becomes
PLATFORM with the platform named in each row's detail — 11 occurrences,
one file, no change to any existing row's label, status or detail.

Six Google states, because an unconfigured account, a half-set
credential list and a deliberate environment suppression call for three
different actions and only one of them is a bug."
```

---

### Task 9: The reconciliation release gate

**Files:**
- Create: `website/src/lib/ads/google-reconciliation.test.ts`
- Create: `website/tests/google-consent.spec.ts` (Playwright)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: nothing. This task is the gate that decides whether the work is production-ready.

- [ ] **Step 1: Write the reconciliation test**

Create `website/src/lib/ads/google-reconciliation.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGooglePurchase } from "./google-events";
import { buildGoogleIdentity } from "./google-matching";
import { wasAlreadySent, type LedgerRow } from "./purchase-ledger";
import type { PaidOrder } from "./tiktok-events";

/**
 * THE RELEASE GATE.
 *
 * A known paid order, asserted against the exact payload Google should receive,
 * then replayed through every way one order has been observed to produce two
 * conversions. If this file passes, the integration reports what it claims to
 * report and cannot double-count. If it does not, nothing ships.
 *
 * The back/forward scenario is not hypothetical: on 2026-08-25 a shopper's
 * back-navigation re-sent the server-side TikTok and Reddit conversions 27
 * seconds after the first send, because the ledger table answered 404.
 */

const KNOWN_ORDER: PaidOrder = {
  orderId: "VL-2026-0001",
  isPaid: true,
  amountPaid: 149.99,
  items: [
    { slug: "bpc-157", productId: "prod_1", productName: "BPC-157 10mg", quantity: 2, unitPrice: 59.995 },
    { slug: "tb-500", productId: "prod_2", productName: "TB-500 5mg", quantity: 1, unitPrice: 30 },
  ],
};

const KNOWN_EMAIL = "First.Last+orders@gmail.com";
const EXPECTED_EMAIL_DIGEST = createHash("sha256").update("firstlast@gmail.com", "utf8").digest("hex");

describe("reconciliation — the exact payload", () => {
  it("produces exactly the expected Google purchase for a known paid order", () => {
    const event = buildGooglePurchase(KNOWN_ORDER, {
      identity: buildGoogleIdentity({ email: KNOWN_EMAIL, phone: null }),
    });

    expect(event).toEqual({
      name: "purchase",
      params: {
        value: 149.99,
        currency: "USD",
        transaction_id: "VL-2026-0001",
        items: [
          { item_id: "bpc-157", item_name: "BPC-157 10mg", quantity: 2, price: 60 },
          { item_id: "tb-500", item_name: "TB-500 5mg", quantity: 1, price: 30 },
        ],
      },
      userData: { sha256_email_address: EXPECTED_EMAIL_DIGEST },
      dedupeKey: "google-purchase:VL-2026-0001",
    });
  });

  it("reports the settled total to the cent, matching the card statement", () => {
    const event = buildGooglePurchase(KNOWN_ORDER);
    expect(event?.params.value).toBe(KNOWN_ORDER.amountPaid);
  });

  it("carries no raw customer data anywhere in the payload", () => {
    const event = buildGooglePurchase(KNOWN_ORDER, {
      identity: buildGoogleIdentity({ email: KNOWN_EMAIL, phone: "+1 555 010 1234" }),
    });
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("First.Last");
    expect(serialised).not.toContain("gmail.com");
    expect(serialised).not.toContain("5550101234");
  });
});

describe("reconciliation — one paid order, one conversion", () => {
  const ledgerAfterFirstSend: LedgerRow[] = [
    { order_id: "VL-2026-0001", platform: "google", delivered: true },
  ];

  it("duplicate webhook delivery does not send twice", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("confirmation page refreshed does not send twice", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("back/forward navigation does not send twice — the 2026-08-25 production incident", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("two tabs resolve to one transaction_id", () => {
    const a = buildGooglePurchase(KNOWN_ORDER);
    const b = buildGooglePurchase(KNOWN_ORDER);
    expect(a?.params.transaction_id).toBe(b?.params.transaction_id);
  });

  it("a link re-opened after 49 hours does not send again, beyond Google's own window", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("another platform's send does NOT suppress Google's", () => {
    expect(wasAlreadySent([{ order_id: "VL-2026-0001", platform: "tiktok", delivered: true }], "google")).toBe(false);
  });

  it("declined then retried then successful reports only the settled order", () => {
    expect(buildGooglePurchase({ ...KNOWN_ORDER, isPaid: false })).toBeNull();
    expect(buildGooglePurchase(KNOWN_ORDER)?.params.transaction_id).toBe("VL-2026-0001");
  });

  it("an abandoned checkout never produces a purchase", () => {
    expect(buildGooglePurchase({ ...KNOWN_ORDER, isPaid: false, amountPaid: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd website && npx vitest run src/lib/ads/google-reconciliation.test.ts`
Expected: PASS, 11 tests. If the payload assertion fails, fix the builder — never loosen the assertion.

- [ ] **Step 3: Write the Playwright consent test**

Create `website/tests/google-consent.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

/**
 * The consent gate, observed in a real browser rather than inferred from
 * source. The assertion that matters is the negative one: no request to
 * googletagmanager.com before someone agrees to it.
 */

const GOOGLE_HOST = /googletagmanager\.com/;

test("makes no Google request before consent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});

test("makes no Google request after declining", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.getByRole("button", { name: /decline/i }).click();
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});

test("mobile viewport behaves identically", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (GOOGLE_HOST.test(request.url())) requests.push(request.url());
  });

  await page.goto("http://localhost:3000/");
  await page.waitForTimeout(2000);

  expect(requests).toEqual([]);
});
```

> Note: local dev is not a production environment, so `browserAdsReportingAllowed()` refuses and the tag will not load even after accepting. That is the environment guard working. A positive "loads after accepting" assertion belongs on a Vercel preview pointed at a **test** conversion action, not on local dev — do not weaken the guard to make a green test.

- [ ] **Step 4: Run the browser tests**

Run: `cd website && npm run dev` in one terminal, then `npx playwright test tests/google-consent.spec.ts`
Expected: 3 passed.

- [ ] **Step 5: Full verification sweep**

Run each, and paste the actual output into the commit or the PR — not a summary of it:

```bash
cd website
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all four clean. A failure here is the task, not a footnote.

- [ ] **Step 6: Commit**

```bash
git add website/src/lib/ads/google-reconciliation.test.ts website/tests/google-consent.spec.ts
git commit -m "test(ads): reconciliation release gate for Google conversions

A known paid order asserted against the exact expected payload, then
replayed through every scenario that has produced a double conversion,
including the back-navigation incident of 2026-08-25.

Also asserts the negative that matters: no request to
googletagmanager.com before consent, on desktop and at 390x844."
```

---

## After the plan

Implementation ends here. What remains is **owner work**, documented in spec §11:
creating the Google Ads account, completing identity and billing verification, creating
the conversion actions, applying for the developer token, and setting the environment
variables. The code is inert until those exist, which is deliberate.

Campaign creation is out of scope for this plan and the spec that precedes it. It is a
separate stage, taken after the account exists and after we know what Google permits for
these products and these landing pages.
