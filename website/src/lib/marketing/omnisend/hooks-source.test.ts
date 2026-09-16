import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The consent, cart, checkout and product-view hooks (spec §4 hook points)
 * run on request paths and inside after(), so their safety is a property of
 * their shape rather than of any one call: the gate is asked before any
 * database work, every body is caught, the log prefix is the module's, and
 * no line ever prints an address, a token or a code. None of that can be
 * exercised against a database here, so it is pinned in source, the way
 * codes-source.test.ts and reconcile-source.test.ts pin their modules.
 */
const HOOKS = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/hooks.ts"), "utf8");

/** Source with comments removed: documenting the rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const hooks = executable(HOOKS);

function fn(name: string): string {
  const start = hooks.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = hooks.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

const HOOK_NAMES = ["onMarketingOptIn", "onPreferencesChanged", "onCartTracked", "onCheckoutStarted", "onProductViewed"] as const;

describe("hooks.ts is server-only and exports exactly the hooks the brief names", () => {
  it("imports server-only on its first line", () => {
    expect(HOOKS.split("\n")[0]).toBe('import "server-only";');
  });

  it.each(HOOK_NAMES)("exports %s", (name) => {
    expect(hooks).toContain(`export async function ${name}(`);
  });
});

describe("every hook asks the gate first, never throws, and logs under the module prefix", () => {
  it.each(HOOK_NAMES)("%s returns on the gate before any await, and wraps the rest in try/catch", (name) => {
    const body = fn(name);
    const gate = body.indexOf("if (!omnisendActive().active) return");
    const firstAwait = body.indexOf("await ");
    const tryBlock = body.indexOf("try {");
    expect(gate).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(gate);
    expect(tryBlock).toBeGreaterThan(gate);
    expect(tryBlock).toBeLessThan(firstAwait);
    expect(body).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG,/);
  });

  it("uses one prefix for every log line", () => {
    expect(hooks).toContain('const LOG = "[omnisend/hooks]";');
    for (const call of hooks.match(/console\.(log|error|warn)\([^)]*\)/g) ?? []) {
      expect(call).toMatch(/^console\.(log|error|warn)\(LOG,/);
    }
  });

  it("never logs an address, a phone number, a token, a code or a key", () => {
    for (const call of hooks.match(/console\.(log|error|warn)\((.|\n)*?\);/g) ?? []) {
      expect(call).not.toMatch(/\b(email|address|phone|token|code|codes|key|link)\b/);
    }
  });
});

describe("onMarketingOptIn", () => {
  const body = fn("onMarketingOptIn");

  it("mints the welcome code only for an address with no paid product order, then upserts the contact with a fresh link and the live codes", () => {
    const facts = body.indexOf("await collectContactFacts(address)");
    const welcome = body.indexOf('await ensureContactCode("welcome", address)');
    const upsert = body.indexOf("await upsertOmnisendContact(address, await contactExtras(address))");
    expect(facts).toBeGreaterThan(-1);
    expect(welcome).toBeGreaterThan(facts);
    expect(upsert).toBeGreaterThan(welcome);
  });

  // THE CHECKOUT OPT-IN IS NOT A FIRST SUBSCRIBE. recordMarketingOptIn runs
  // from create-session with source "checkout", BEFORE payment: a welcome code
  // minted there is a first-order discount handed to someone in the middle
  // of their first order, and the contact push carries it into the welcome
  // flow's first email at once. The consent still reaches Omnisend; the
  // code waits for a sign-up or an account opt-in.
  it("mints nothing for the checkout opt-in, whatever the order count, and pushes the contact either way", () => {
    expect(body).toContain('if (source !== "checkout" && facts.orders === 0) await ensureContactCode("welcome", address);');
    expect(body).not.toContain("if (facts.orders === 0) await ensureContactCode");
    // The push is unconditional on the source: the guard returns nothing early.
    const guard = body.indexOf('if (source !== "checkout" && facts.orders === 0)');
    const upsert = body.indexOf("await upsertOmnisendContact(address, await contactExtras(address))");
    expect(body.slice(guard, upsert)).not.toContain("return");
  });
});

describe("onPreferencesChanged", () => {
  it("re-upserts the contact so consent reaches Omnisend exactly as stored, minting nothing", () => {
    const body = fn("onPreferencesChanged");
    expect(body).toContain("await upsertOmnisendContact(address, await contactExtras(address))");
    expect(body).not.toContain("ensureContactCode(");
  });
});

describe("the contact extras are read, never minted", () => {
  it("collect a fresh signed link and the live codes", () => {
    const extras = hooks.slice(hooks.indexOf("async function contactExtras("));
    expect(extras).toContain("signOmnisendLink(email, now)");
    expect(extras).toContain("findLiveContactCodes(email)");
    expect(extras).toContain("OMNISEND_LINK_TTL_MS");
  });
});

describe("the cart hooks", () => {
  it.each(["onCartTracked", "onCheckoutStarted"] as const)("%s refuses a cart that already has an in-house stage, before any event is built", (name) => {
    const body = fn(name);
    const legacy = body.indexOf("if (await cartHasInHouseStage(input.cartId)) return;");
    const send = body.indexOf("await sendCartEventOnce(");
    expect(legacy).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(legacy);
  });

  it("send the two cart events by name, each debounced per cart by the ten-minute window", () => {
    expect(fn("onCartTracked")).toContain('name: "added product to cart"');
    expect(fn("onCartTracked")).toContain("debounceMs: CART_EVENT_DEBOUNCE_MS");
    expect(fn("onCheckoutStarted")).toContain('name: "started checkout"');
    expect(fn("onCheckoutStarted")).toContain("debounceMs: CART_EVENT_DEBOUNCE_MS");
  });

  // ONCE A CART HAS REACHED THE CHECKOUT, THE CHECKOUT FLOW OWNS IT. A cart
  // change ten minutes after arriving at the till used to send `added product
  // to cart` again, which put the shopper back into Omnisend's abandoned-cart
  // flow they had just left for the abandoned-checkout one, and the two flows
  // then mailed the same inbox about the same cart. The test is the fact, not
  // the time: the row's first-touch stamp, or a `started checkout` claim for
  // the cart, whenever either was set.
  it("never send a cart event for a cart that has reached the checkout, however long ago", () => {
    const body = fn("onCartTracked");
    const checkout = body.indexOf("if (await cartReachedCheckout(input.cartId)) return;");
    const send = body.indexOf("await sendCartEventOnce(");
    expect(checkout).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(checkout);
    expect(fn("onCheckoutStarted")).not.toContain("cartReachedCheckout(");
    expect(hooks).not.toContain("checkoutReportedRecently");

    const check = hooks.slice(hooks.indexOf("async function cartReachedCheckout("), hooks.indexOf("export async function sendCartEventOnce("));
    expect(check).toMatch(/from\("abandoned_carts"\)\.select\("checkout_started_at"\)\.eq\("id", cartId\)/);
    expect(check).toMatch(/from\("omnisend_events_sent"\)[\s\S]*\.eq\("entity_id", cartId\)[\s\S]*\.eq\("event_name", "started checkout"\)/);
    // No window: neither the debounce nor any other clock is consulted.
    expect(check).not.toContain("CART_EVENT_DEBOUNCE_MS");
    expect(check).not.toContain("Date.now()");
    expect(check).not.toContain("since");
    // Either fact alone is enough.
    expect(check).toContain("if (stamped) return true;");
    expect(check).toContain("return claimed;");
    // Fails OPEN: a read failure sends the cart event, the cheaper mistake.
    expect(check).toMatch(/catch \(error\) \{[^}]*return false;/);
  });

  it("read the legacy stage from abandoned_cart_emails and fail CLOSED, because a wrong send double-mails a shopper mid-ladder", () => {
    const check = hooks.slice(hooks.indexOf("async function cartHasInHouseStage("), hooks.indexOf("async function cartReachedCheckout("));
    expect(check).toMatch(/from\("abandoned_cart_emails"\)\s*\.select\("id"\)\s*\.eq\("abandoned_cart_id", cartId\)\s*\.limit\(1\)/);
    expect(check).toMatch(/if \(error\) \{[^}]*return true;/);
    expect(check).toMatch(/catch \(error\) \{[^}]*return true;/);
  });

  it("build the checkout URL from the in-house restore link, behind the contact's own signed door", () => {
    const send = hooks.slice(hooks.indexOf("export async function sendCartEventOnce("));
    expect(send).toContain("sitePathOf(restoreUrl(input.cart.cartId))");
    expect(send).toContain("checkoutUrl: await link(");
    expect(hooks).toMatch(/import \{[^}]*restoreUrl[^}]*\} from "@\/lib\/cart-recovery";/);
  });

  it("price every line from the catalogue, never from the beacon", () => {
    const send = hooks.slice(hooks.indexOf("export async function sendCartEventOnce("));
    expect(send).toContain("await getCatalogProductsBySlugs(");
    expect(send).toContain("priceCartLines(");
    expect(send).not.toContain("unitPrice");
  });

  it("claim the ledger before the send, record the outcome, and release on a thrown error", () => {
    const send = hooks.slice(hooks.indexOf("export async function sendCartEventOnce("));
    const claim = send.indexOf("await ledger.claimSendWithin(input.name, event.eventID, input.debounceMs)");
    const once = send.indexOf("await ledger.claimSend(input.name, event.eventID)");
    const post = send.indexOf("await sendOmnisendEvent(event)");
    const record = send.indexOf("await ledger.recordSend(input.name, event.eventID, result.ok, result.error)");
    const release = send.indexOf("await ledger.releaseSend(input.name)");
    expect(claim).toBeGreaterThan(-1);
    expect(once).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(claim);
    expect(record).toBeGreaterThan(post);
    expect(release).toBeGreaterThan(post);
  });
});

describe("onProductViewed", () => {
  const body = fn("onProductViewed");

  it("sends viewed product through buildViewedProduct, at most once per address and slug per six hours", () => {
    expect(body).toContain("buildViewedProduct({");
    expect(body).toContain('await ledger.claimSendWithin("viewed product", event.eventID, PRODUCT_VIEW_DEBOUNCE_MS)');
  });

  it("keys the ledger on a hash of the address rather than the address itself", () => {
    expect(body).toContain("omnisendLedger(`view:${hashed(address)}:${slug}`)");
    expect(hooks).toMatch(/function hashed\(value: string\): string \{\s*return createHash\("sha256"\)/);
  });

  it("treats only Out of Stock as outOfStock, matching the catalogue sync", () => {
    expect(body).toContain('inStock: product.stockStatus !== "Out of Stock"');
  });
});
