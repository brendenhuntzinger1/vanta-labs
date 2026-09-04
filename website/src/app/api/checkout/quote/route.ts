import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { readOfferCookie, readOfferStatus } from "@/lib/offers/customer-offers";
import { quoteOrder } from "@/lib/quote-order";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// WHAT THE SHOPPER IS ABOUT TO PAY, ANSWERED BY THE THING THAT CHARGES THEM.
//
// The cart and the checkout summary have always priced themselves in the
// browser, and that was fine while the browser could see everything that moves
// a total. A one-time offer breaks that: the token lives in an httpOnly cookie
// on purpose, so the page cannot read it, cannot know the gift applies, and
// cannot know what it is worth. The result was a checkout that showed
// $15 shipping and no free vial on an order the server was about to price at
// $0 shipping with a vial in it — correct at the till, wrong on the screen,
// and wrong exactly where the shopper decides whether to go through with it.
//
// The fix is not to teach the client the offer rules. That is a second pricing
// implementation, and the store already carries the scar of one: the
// "Altered total detected" guard exists because a hand-written Buy-X-Get-Y loop
// in the cart drifted from the one in the server. So this endpoint runs
// quoteOrder — the same function, on the same inputs — and hands back the
// numbers to render.
//
// IT IS A PREVIEW AND ONLY A PREVIEW:
//
//   * quoteOrder takes no lock and reserves nothing, in any mode. Nothing here
//     writes.
//   * The response carries NO token. The gift is described, never granted.
//   * A free line still only becomes real through create-session, which
//     re-quotes in "full" mode and then reserves the offer under a lock bound
//     to the checkout email. A preview cannot manufacture one.
//
// Errors are answers, not failures: every pricing refusal comes back as
// `{ ok: false }` with a reason, and the caller keeps rendering what it had.
// A summary must never go blank because a preview timed out.
// ---------------------------------------------------------------------------

type QuoteBody = {
  items?: Array<{ id?: unknown; quantity?: unknown }>;
  email?: unknown;
  country?: unknown;
  state?: unknown;
  couponCode?: unknown;
  referralCode?: unknown;
  shippingProtection?: unknown;
  pointsToRedeem?: unknown;
  paymentMethod?: unknown;
};

const text = (value: unknown, max = 120) => String(value ?? "").trim().slice(0, max);

function declined(reason: string) {
  // Always 200. A caller that renders on `ok` cannot be broken by a 4xx it
  // forgot to handle, and there is nothing here worth an error page.
  return NextResponse.json({ ok: false, reason });
}

export async function POST(request: Request) {
  try {
    // The gate. No cookie, no offer, no preview — and the client should not
    // have called at all, so this costs nothing in the ordinary case.
    const token = readOfferCookie(request);
    if (!token) return declined("no_offer");

    // Cheaper than create-session and read-only, but it does run the full
    // pricing pass against the database, so it gets a limit of its own. A
    // shopper editing a cart generates a handful of these; a script pointed at
    // it generates thousands.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const rateLimit = await checkRateLimit(`checkout-quote:${ip}`, 60, 60);
    if (!rateLimit.allowed) return declined("rate_limited");

    const status = await readOfferStatus(token);
    if (!status) return declined("no_offer");

    const body = (await request.json().catch(() => ({}))) as QuoteBody;
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((item) => ({ id: text(item?.id, 200), quantity: Number(item?.quantity) }))
      .filter((item) => item.id && Number.isFinite(item.quantity) && item.quantity > 0);
    if (items.length === 0) return declined("empty_cart");

    // WHOSE ADDRESS THIS IS PRICED FOR.
    //
    // The offer is bound to the address it was mailed to, and peekCustomerOffer
    // enforces that — so a preview asked before the shopper has typed anything
    // would resolve no offer and quote the gift away in the cart, which is the
    // bug this endpoint exists to fix. Two cases, and the difference is
    // reported so the caller can word it honestly:
    //
    //   typed an address  → price for THAT address. If it is not the one the
    //                       offer was sent to, the gift correctly does not
    //                       apply, and the shopper finds that out here rather
    //                       than after paying.
    //   typed nothing yet → price for the bound address, which answers the
    //                       question the cart banner already poses: what do I
    //                       get if I use the address this was sent to.
    const typedEmail = text(body.email, 200).toLowerCase();
    const emailForQuote = typedEmail || status.email;
    const assumedBoundEmail = !typedEmail;

    const authenticatedUser = await getAuthenticatedUser();
    const isCustomer = Boolean(authenticatedUser) && detectRoleFromUser(authenticatedUser!) === "customer";
    const customerUserId = isCustomer ? authenticatedUser!.id : undefined;

    // The cart drawer knows no destination at all and has always estimated
    // domestic postage; saying so explicitly keeps the preview's shipping row
    // identical to the row it replaces rather than quietly better or worse.
    const country = text(body.country, 60) || "United States";

    let quote;
    try {
      quote = await quoteOrder({
        items,
        customer: {
          email: emailForQuote,
          fullName: "",
          address: "",
          city: "",
          postalCode: "",
          state: text(body.state, 60),
          country,
        },
        referralCode: text(body.referralCode, 60) || undefined,
        couponCode: text(body.couponCode, 60) || undefined,
        customerUserId,
        pointsToRedeem: Number.isFinite(Number(body.pointsToRedeem)) ? Math.max(0, Number(body.pointsToRedeem)) : 0,
        shippingProtection: Boolean(body.shippingProtection),
        paymentMethod: text(body.paymentMethod, 60) || "card",
        offerToken: token,
        mode: "preview",
      });
    } catch (error) {
      // Out of stock, below the profit floor, a coupon this shopper cannot use:
      // all real answers, none of them this endpoint's business to explain. The
      // checkout itself will say so properly when they submit.
      console.warn("[checkout/quote] not priceable:", error instanceof Error ? error.message : error);
      return declined("not_priceable");
    }

    // The gift lines, identified the same way order creation does: a $0 line
    // the shopper did not put in the basket. Reported separately so a summary
    // can render it as a gift rather than as a mysterious free product.
    const requested = new Set(items.map((item) => item.id));
    const giftLines = quote.lineItems
      .filter((line) => line.baseUnitPrice === 0 && !requested.has(line.product.id))
      .map((line) => ({
        name: line.product.name,
        variantLabel: line.product.variantLabel ?? null,
        quantity: line.quantity,
      }));

    return NextResponse.json({
      ok: true,
      quote: {
        subtotal: quote.subtotal,
        shipping: quote.shipping,
        discountAmount: quote.discountAmount,
        taxAmount: quote.taxAmount,
        // The summary already renders "Enter address" for an unresolved tax
        // row; this preserves that rather than showing a confident $0.
        taxKnown: quote.taxQuote.reason !== "no_state",
        taxState: quote.taxQuote.state ?? null,
        taxRatePercent: quote.taxQuote.ratePercent,
        shippingProtectionFee: quote.shippingProtectionFee,
        storeCreditRedeemedCents: quote.storeCreditRedeemedCents,
        pointsDiscountAmount: quote.pointsDiscountAmount,
        expectedTotal: quote.expectedTotal,
        cardFeeAmount: quote.cardFee.amount,
        cardFeePercent: quote.cardFee.percentage,
        finalTotal: quote.finalTotal,
        couponCode: quote.couponCode,
        giftLines,
        // Described, never granted: the kind and the wording, no token. Only
        // the halves that actually changed this order are named — a gift
        // beaten outright by a better discount comes back as null.
        offer: quote.appliedOffer
          ? {
              rewardKind: quote.appliedOffer.rewardKind,
              description: quote.appliedOffer.description,
              productApplied: quote.appliedOffer.productApplied,
              shippingApplied: quote.appliedOffer.shippingApplied,
              percentApplied: quote.appliedOffer.percentApplied,
            }
          : null,
        // What the discount line should be called: "15% gift" when the gift's
        // percentage won, "Coupon" when a code did, the perk's name otherwise.
        discountLabel: quote.discountLabel,
        assumedBoundEmail,
      },
    });
  } catch (error) {
    console.error("[checkout/quote]", error);
    return declined("unavailable");
  }
}
