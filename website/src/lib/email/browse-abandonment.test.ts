import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUTOMATION_KEYS, AUTOMATION_LABELS, selectAutomationTargets, type AutomationTarget } from "@/lib/email/automations";
import { AUTOMATION_QUIET_MS } from "@/lib/email/frequency";
import {
  BROWSE_MAX_AGE_MS,
  BROWSE_MIN_AGE_MS,
  BROWSE_OPEN_CART_STATUSES,
  BROWSE_REPEAT_MS,
  browseDestinationPath,
  browseReferenceId,
  mergeProductName,
  parseBrowseReference,
} from "@/lib/email/browse-abandonment";
import { browseAbandonmentTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// BROWSE ABANDONMENT: who gets the note, when, and what it says.
//
// Design §6: a viewed product, an identifiable and consented customer, no cart
// and no purchase, one useful note after a few hours, no incentive. Every rule
// below is one the owner asked for by name — "respect all existing
// suppression, frequency and consent rules and make sure it cannot collide
// annoyingly with cart, checkout, welcome or post-purchase flows".
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-12T15:00:00Z");
const WHO = "viewer@example.test";
const SLUG = "ghk-cu-50mg";

function select(overrides: Partial<Parameters<typeof selectAutomationTargets>[0]> = {}) {
  const deferred: AutomationTarget[] = [];
  const targets = selectAutomationTargets({
    key: "browse_abandonment",
    delayDays: 0,
    consented: new Set([WHO]),
    accounts: new Set([WHO]),
    accountCreatedAt: new Map(),
    subscribedAt: new Map(),
    paidOrders: [],
    alreadySent: new Set(),
    lastMarketingSentAt: new Map(),
    quietMs: AUTOMATION_QUIET_MS,
    productViews: new Map([[WHO, { slug: SLUG, at: NOW - 6 * HOUR }]]),
    openCartEmails: new Set(),
    browseSentAt: new Map(),
    onDeferred: (t) => deferred.push(t),
    now: NOW,
    limit: 100,
    ...overrides,
  });
  return { targets, deferred };
}

describe("the reference and the destination", () => {
  it("round-trips address, slug and the view's day, and lands on that product", () => {
    const reference = browseReferenceId("Viewer@Example.test", SLUG, NOW - 6 * HOUR);
    expect(reference).toBe(`${WHO}:${SLUG}:2026-09-12`);
    expect(parseBrowseReference(reference)).toEqual({ email: WHO, slug: SLUG, day: "2026-09-12" });
    expect(browseDestinationPath(reference)).toBe(`/products/${SLUG}`);
  });

  it("refuses a reference whose slug could not be a product page", () => {
    expect(parseBrowseReference(`${WHO}:../admin:2026-09-12`)).toBeNull();
    expect(parseBrowseReference(`${WHO}:GHK CU:2026-09-12`)).toBeNull();
    expect(parseBrowseReference(`${WHO}:${SLUG}:yesterday`)).toBeNull();
    expect(browseDestinationPath("nonsense")).toBeNull();
  });

  it("replaces every {{product_name}} token and nothing else", () => {
    expect(mergeProductName("About {{product_name}} and {{ Product_Name }}; {{other}} stays", "GHK-Cu 50mg"))
      .toBe("About GHK-Cu 50mg and GHK-Cu 50mg; {{other}} stays");
  });

  it("names the same open statuses the cart flow does", () => {
    expect([...BROWSE_OPEN_CART_STATUSES]).toEqual(["active", "held"]);
  });
});

describe("the automation key", () => {
  it("is last in priority, so every other message to an address wins the tick", () => {
    expect(AUTOMATION_KEYS[AUTOMATION_KEYS.length - 1]).toBe("browse_abandonment");
    expect(AUTOMATION_LABELS.browse_abandonment.label).toBeTruthy();
  });
});

describe("who is selected", () => {
  it("a consented account holder who viewed a product six hours ago, with no cart and no order", () => {
    const { targets } = select();
    expect(targets).toEqual([{ email: WHO, referenceId: `${WHO}:${SLUG}:2026-09-12`, slug: SLUG }]);
  });

  it("only between four and twenty-four hours after the view", () => {
    const views = (age: number) => new Map([[WHO, { slug: SLUG, at: NOW - age }]]);
    expect(select({ productViews: views(BROWSE_MIN_AGE_MS - 1) }).targets).toEqual([]);
    expect(select({ productViews: views(BROWSE_MIN_AGE_MS) }).targets).toHaveLength(1);
    expect(select({ productViews: views(BROWSE_MAX_AGE_MS) }).targets).toHaveLength(1);
    expect(select({ productViews: views(BROWSE_MAX_AGE_MS + 1) }).targets).toEqual([]);
  });

  it("never a guest subscriber, and never someone who has not consented", () => {
    expect(select({ accounts: new Set() }).targets).toEqual([]);
    expect(select({ consented: new Set() }).targets).toEqual([]);
  });

  it("never someone with an open cart: the cart flow owns them", () => {
    expect(select({ openCartEmails: new Set([WHO]) }).targets).toEqual([]);
  });

  it("never someone who bought at or after the view, but a purchase before it does not matter", () => {
    const view = NOW - 6 * HOUR;
    expect(select({ paidOrders: [{ email: WHO, orderId: "o1", at: view }] }).targets).toEqual([]);
    expect(select({ paidOrders: [{ email: WHO, orderId: "o1", at: view + HOUR }] }).targets).toEqual([]);
    expect(select({ paidOrders: [{ email: WHO, orderId: "o0", at: view - 30 * DAY }] }).targets).toHaveLength(1);
  });

  it("never twice for the same product on the same day", () => {
    expect(select({ alreadySent: new Set([`${WHO}:${SLUG}:2026-09-12`]) }).targets).toEqual([]);
  });

  it("at most once a week per address, whatever they looked at", () => {
    expect(select({ browseSentAt: new Map([[WHO, NOW - 3 * DAY]]) }).targets).toEqual([]);
    expect(select({ browseSentAt: new Map([[WHO, NOW - BROWSE_REPEAT_MS]]) }).targets).toHaveLength(1);
  });

  it("is deferred, not dropped, when anything marketing-shaped reached the inbox inside the quiet period", () => {
    const { targets, deferred } = select({ lastMarketingSentAt: new Map([[WHO, NOW - HOUR]]) });
    expect(targets).toEqual([]);
    expect(deferred).toHaveLength(1);
  });

  it("is invisible to every other automation", () => {
    for (const key of AUTOMATION_KEYS) {
      if (key === "browse_abandonment") continue;
      expect(select({ key, delayDays: 1 }).targets, key).toEqual([]);
    }
  });
});

describe("the note", () => {
  const base = {
    subject: "Still looking at {{product_name}}?",
    headline: "About {{product_name}}",
    body: "You were looking at {{product_name}} a little while ago, so here is the page again in case it is useful.\n\nIf a question is holding you up, reply to this email. A person reads and answers every one.",
    ctaLabel: "See the product page",
    ctaUrl: "https://vanta.test/api/email/automation-click?k=browse_abandonment",
    productName: "GHK-Cu 50mg",
    productPriceLabel: "$47.99",
    productImage: "https://vanta.test/images/ghk.png",
    coaUrl: "https://vanta.test/coa/ghk-cu-50mg",
    postalAddress: "1 Nowhere Lane",
  };

  it("puts the catalogue name where the operator wrote the token", () => {
    const mail = browseAbandonmentTemplate(base);
    expect(mail.subject).toBe("Still looking at GHK-Cu 50mg?");
    expect(mail.html).toContain("About GHK-Cu 50mg");
    expect(mail.html).toContain("You were looking at GHK-Cu 50mg a little while ago");
    expect(mail.text).toContain("You were looking at GHK-Cu 50mg a little while ago");
    expect(mail.html).not.toContain("{{");
  });

  it("shows the product with its price and image, and links the batch report when there is one", () => {
    const mail = browseAbandonmentTemplate(base);
    expect(mail.html).toContain("$47.99");
    expect(mail.html).toContain('src="https://vanta.test/images/ghk.png"');
    expect(mail.html).toContain('href="https://vanta.test/coa/ghk-cu-50mg"');
    expect(mail.text).toContain("https://vanta.test/coa/ghk-cu-50mg");
    const without = browseAbandonmentTemplate({ ...base, coaUrl: null, productImage: undefined });
    expect(without.html).not.toMatch(/certificate of analysis/i);
    expect(without.html).not.toContain("<img");
  });

  it("carries no incentive of any kind", () => {
    const mail = browseAbandonmentTemplate(base);
    expect(mail.html).not.toMatch(/% off|code|gift|free shipping|discount/i);
    expect(mail.text).not.toMatch(/% off|code|gift|free shipping|discount/i);
  });

  it("has one button, to the tracked link, and repeats it in the text", () => {
    const mail = browseAbandonmentTemplate(base);
    expect(mail.html).toContain(`href="${base.ctaUrl}"`);
    expect(mail.text).toContain(`See the product page: ${base.ctaUrl}`);
    expect(mail.text).toContain("1 Nowhere Lane");
  });
});
