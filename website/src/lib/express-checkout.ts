// The "Apple Pay" express-checkout button is only functional once a payment
// processor's Apple Pay / Payment Request integration is wired to it. Until
// then it is a cosmetic control that merely opens the normal checkout form —
// misleading to a shopper who taps it expecting a one-tap Apple Pay sheet, and
// an unlicensed use of the Apple Pay mark. So it (and the Apple Pay accepted-
// payment pill) stays hidden by default.
//
// To turn it on: connect the processor, wire its Apple Pay handler into the
// express slot in cart-drawer.tsx, then set the env var below to "true" in the
// deployment environment (Vercel). No code change is needed to flip it, but the
// handler MUST be real before you do — this flag only controls visibility.
export const EXPRESS_CHECKOUT_ENABLED =
  process.env.NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED === "true";
