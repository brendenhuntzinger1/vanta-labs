import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WHERE THE STORE TELLS OMNISEND WHAT HAPPENED (spec §4 hook points).
 *
 * Each call site is pinned in source: the hook is called AFTER the real
 * work, inside after() (or the omnisendAfter wrapper, which is after() with
 * a fire-and-forget fallback for a library function reached outside a
 * request), and never awaited on the path that answers the customer. A
 * behavioural test could only prove the call for the inputs it thought of;
 * this proves the shape for every input.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Source with comments removed: documenting the rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const AFTER = executable(read("src/lib/marketing/omnisend/after.ts"));
const BROADCAST = executable(read("src/lib/marketing-broadcast.ts"));
const PREFERENCES = executable(read("src/app/api/account/preferences/route.ts"));
const CART_RECOVERY = executable(read("src/lib/cart-recovery.ts"));
const PRODUCT_PAGE = executable(read("src/app/products/[slug]/page.tsx"));
const SWEEP = executable(read("src/app/api/cron/sweep/route.ts"));
const TRACK_ROUTE = executable(read("src/app/api/cart/track/route.ts"));
const CART_CONTEXT = executable(read("src/components/cart-context.tsx"));

function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : undefined);
}

describe("omnisendAfter is after() with a fallback, and swallows the hook's failure", () => {
  it("imports after from next/server and calls it with the work", () => {
    expect(AFTER).toContain('import { after } from "next/server";');
    expect(AFTER).toMatch(/try \{\s*after\(run\);\s*\} catch \{\s*void run\(\);\s*\}/);
  });

  it("catches whatever the hook throws, under the module prefix", () => {
    expect(AFTER).toMatch(/catch \(error\) \{\s*console\.error\("\[omnisend\/after\] hook failed", error\);/);
  });
});

describe("recordMarketingOptIn tells Omnisend after a SUCCESSFUL record, off the caller's path", () => {
  const body = fn(BROADCAST, "recordMarketingOptIn");

  it("schedules onMarketingOptIn after the refusal check and before returning true", () => {
    const refused = body.indexOf("return false;", body.indexOf("if (error) {"));
    const hook = body.indexOf("omnisendAfter(() => import(\"@/lib/marketing/omnisend/hooks\").then((hooks) => hooks.onMarketingOptIn(normalized, source)));");
    const success = body.indexOf("return true;");
    expect(refused).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(refused);
    expect(success).toBeGreaterThan(hook);
  });

  it("never awaits the hook, so the three callers (signup, session, checkout) cannot block on it", () => {
    expect(body).not.toContain("await import(");
    expect(body).not.toMatch(/await [^\n]*onMarketingOptIn/);
    expect(BROADCAST).toContain('import { omnisendAfter } from "@/lib/marketing/omnisend/after";');
  });
});

describe("the account preferences route re-syncs the contact after a successful write", () => {
  it("calls onPreferencesChanged inside after(), after the preference upsert and before the success response", () => {
    expect(PREFERENCES).toContain('import { after } from "next/server";');
    expect(PREFERENCES).toContain('import { onPreferencesChanged } from "@/lib/marketing/omnisend/hooks";');
    const upsert = PREFERENCES.indexOf('from("customer_preferences").upsert(');
    const hook = PREFERENCES.indexOf("after(() => onPreferencesChanged(email));");
    const success = PREFERENCES.indexOf("return NextResponse.json({ success: true });");
    expect(upsert).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(upsert);
    expect(success).toBeGreaterThan(hook);
  });

  it("only for an address the session actually carries", () => {
    const hook = PREFERENCES.indexOf("after(() => onPreferencesChanged(email));");
    const guard = PREFERENCES.lastIndexOf("if (email) {", hook);
    expect(guard).toBeGreaterThan(-1);
  });
});

describe("cart-recovery.ts reports carts to Omnisend after the row is written", () => {
  it("trackCart calls onCartTracked with the row id on both the update and the insert path, after the write", () => {
    const body = fn(CART_RECOVERY, "trackCart");
    const update = body.indexOf('.from("abandoned_carts").update(payload)');
    const updateHook = body.indexOf('reportCartToOmnisend("onCartTracked", { cartId: String(existing.id)');
    const insert = body.indexOf('.from("abandoned_carts").insert({');
    const insertHook = body.indexOf('reportCartToOmnisend("onCartTracked", { cartId: String(cartId)');
    expect(update).toBeGreaterThan(-1);
    expect(updateHook).toBeGreaterThan(update);
    expect(insert).toBeGreaterThan(updateHook);
    expect(insertHook).toBeGreaterThan(insert);
    // The insert reads its id back, so the hook can name the cart.
    expect(body).toContain('.select("id").maybeSingle()');
  });

  it("markCheckoutStarted calls onCheckoutStarted after the stamp, from the open row", () => {
    const body = fn(CART_RECOVERY, "markCheckoutStarted");
    const stamp = body.indexOf(".update({ checkout_started_at: new Date().toISOString() })");
    const read = body.indexOf('.select("id, email, items, cart_value_cents")');
    const hook = body.indexOf('reportCartToOmnisend("onCheckoutStarted", {');
    expect(stamp).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(stamp);
    expect(hook).toBeGreaterThan(read);
  });

  it("schedules both hooks through omnisendAfter with a dynamic import, never awaited on the beacon's path", () => {
    const report = CART_RECOVERY.slice(CART_RECOVERY.indexOf("function reportCartToOmnisend("), CART_RECOVERY.indexOf("\n}\n", CART_RECOVERY.indexOf("function reportCartToOmnisend(")));
    expect(report).toContain('omnisendAfter(() => import("@/lib/marketing/omnisend/hooks").then((hooks) => hooks.onCartTracked(input)));');
    expect(report).toContain('omnisendAfter(() => import("@/lib/marketing/omnisend/hooks").then((hooks) => hooks.onCheckoutStarted(input)));');
    expect(report).not.toContain("await ");
    expect(CART_RECOVERY).toContain('import { omnisendAfter } from "@/lib/marketing/omnisend/after";');
    // No static import of the hooks module: it imports this file for the restore link.
    expect(CART_RECOVERY).not.toMatch(/^import [^\n]*from "@\/lib\/marketing\/omnisend\/hooks";/m);
  });

  it("exports the restore link and the recovery context the Omnisend modules reuse", () => {
    expect(CART_RECOVERY).toContain("export function restoreUrl(cartId: string)");
    expect(CART_RECOVERY).toContain("export async function loadRecoveryContext(emails: string[], now: number): Promise<RecoveryContext>");
    expect(CART_RECOVERY).toContain("export function lastGiftForOtherCarts(");
    expect(CART_RECOVERY).toContain("export async function unshippableGiftSlugsFor(giftSlugs: string[]): Promise<Set<string>>");
  });
});

// A FIRST-TIME GUEST NEVER PRODUCED `started checkout`. The client fired the
// arrival beacon once, with items: [], and the route stamped the checkout
// start on a row that did not exist yet: a guest has no abandoned_carts row
// until an address is typed, and the beacon that follows the typed address
// only ever ran trackCart. So the debounced items beacon also says
// reachedCheckout while the shopper is on /checkout, and the route, given
// items AND reachedCheckout, tracks the cart first and stamps it after, so
// the row exists to stamp and the hook has a row to report. The one-shot
// arrival beacon and the empty-items path stay as they were.
describe("the checkout beacon reaches a guest's cart row", () => {
  it("the client's debounced items beacon carries reachedCheckout while the pathname is under /checkout", () => {
    const beacon = CART_CONTEXT.slice(CART_CONTEXT.indexOf("const timeout = setTimeout(() => {"), CART_CONTEXT.indexOf("}, 1500);"));
    expect(beacon).toContain("cartValueCents: Math.round(subtotal * 100),");
    expect(beacon).toContain('...(pathname?.startsWith("/checkout") ? { reachedCheckout: true } : {}),');
    // The pathname is a dependency of that effect, not something read inside it.
    const deps = CART_CONTEXT.indexOf("}, [isSignedIn, hasTrackableIdentity, trackedEmail, cartSessionId, items, customerName, subtotal, pathname]);");
    expect(deps).toBeGreaterThan(-1);
    // usePathname is called once, before the tracking effect.
    expect(CART_CONTEXT.split("usePathname()").length - 1).toBe(1);
    expect(CART_CONTEXT.indexOf("const pathname = usePathname();")).toBeLessThan(CART_CONTEXT.indexOf("const timeout = setTimeout(() => {"));
  });

  it("keeps the one-shot arrival beacon", () => {
    expect(CART_CONTEXT).toContain("body: JSON.stringify({ sessionId: cartSessionId, items: [], reachedCheckout: true }),");
    expect(CART_CONTEXT).toContain("const checkoutStartSentRef = useRef(false);");
  });

  it("the route stamps an empty arrival before identity, and a tracked cart after trackCart", () => {
    const post = TRACK_ROUTE.slice(TRACK_ROUTE.indexOf("export async function POST("));
    const emptyArrival = post.indexOf("if (body.reachedCheckout === true && body.items.length === 0) {");
    const firstStamp = post.indexOf("await markCheckoutStarted(sessionId);", emptyArrival);
    const identity = post.indexOf("const user = await getAuthenticatedUser();");
    const ipLimit = post.indexOf('checkRateLimit(rateLimitKeyForRequest("cart-track-ip", request)');
    const emailLimit = post.indexOf("checkRateLimit(`cart-track-email:${typed}`");
    const track = post.indexOf("await trackCart({");
    const secondStamp = post.indexOf("if (body.reachedCheckout === true) await markCheckoutStarted(sessionId);");
    expect(emptyArrival).toBeGreaterThan(-1);
    expect(firstStamp).toBeGreaterThan(emptyArrival);
    expect(identity).toBeGreaterThan(firstStamp);
    expect(ipLimit).toBeGreaterThan(identity);
    expect(emailLimit).toBeGreaterThan(ipLimit);
    expect(track).toBeGreaterThan(emailLimit);
    expect(secondStamp).toBeGreaterThan(track);
    // Exactly two stamps: the empty arrival and the tracked cart.
    expect(post.split("await markCheckoutStarted(sessionId);").length - 1).toBe(2);
    // The old shape — stamping before knowing whether there is a row — is gone.
    expect(post).not.toContain("if (body.reachedCheckout === true) {\n    await markCheckoutStarted(sessionId);");
  });
});

describe("the product page reports a view for a signed-in viewer only, inside the existing after()", () => {
  it("calls onProductViewed beside recordProductView, under the viewer.email guard", () => {
    expect(PRODUCT_PAGE).toContain('import { onProductViewed } from "@/lib/marketing/omnisend/hooks";');
    const guard = PRODUCT_PAGE.indexOf("if (viewer?.email) {");
    const after = PRODUCT_PAGE.indexOf("after(async () => {", guard);
    const record = PRODUCT_PAGE.indexOf("await recordProductView({ email: viewerEmail, customerUserId: viewerId, slug: product.slug });", after);
    const hook = PRODUCT_PAGE.indexOf("await onProductViewed(viewerEmail, product);", record);
    const close = PRODUCT_PAGE.indexOf("});", hook);
    expect(guard).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(guard);
    expect(record).toBeGreaterThan(after);
    expect(hook).toBeGreaterThan(record);
    expect(close).toBeGreaterThan(hook);
    // Exactly one after() on the page: the view is not scheduled twice.
    expect(PRODUCT_PAGE.split("after(").length - 1).toBe(1);
  });

  it("does not report a guest on a marketing-link grant", () => {
    const hook = PRODUCT_PAGE.indexOf("onProductViewed(viewerEmail");
    const guard = PRODUCT_PAGE.lastIndexOf("if (viewer?.email) {", hook);
    const redirect = PRODUCT_PAGE.indexOf("redirect(`/account/login?next=");
    expect(guard).toBeGreaterThan(redirect);
  });
});

describe("the scheduled sweep runs the Omnisend cart-offer job", () => {
  it("registers mintOmnisendCartOffers under its own key and label", () => {
    expect(SWEEP).toContain('import { mintOmnisendCartOffers } from "@/lib/marketing/omnisend/cart-offers";');
    expect(SWEEP).toContain('omnisendCartOffers: { label: "omnisend_cart_offers", run: () => mintOmnisendCartOffers() },');
  });
});
