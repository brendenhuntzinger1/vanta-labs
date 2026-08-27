import { ReactNode } from "react";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// Checkout is a private, transactional page — keep it out of the index even if
// a URL leaks externally (robots.txt Disallow blocks crawling but not indexing
// of linked URLs; noindex is the robust guard). Applies to the client page.tsx.
export const metadata: Metadata = {
  // page.tsx is a Client Component and cannot export metadata at all, so the
  // title lives here with the robots rule rather than one segment deeper.
  // Without it the tab, and any bookmark, read "Vanta Labs | Premium Research
  // Peptides" — the site-wide default — at the one moment a shopper is most
  // likely to have several tabs open and be deciding which is their checkout.
  title: "Checkout",
  description: "Complete your Vanta Labs order with encrypted checkout and tracked shipping.",
  robots: { index: false, follow: false },
};

// GUEST CHECKOUT is enabled: checkout is open to everyone. A signed-in customer
// gets their order tied to their account (and locked to their account email);
// a guest checks out with just the email they enter. Account-only perks (points,
// store credit) are gated server-side on the authenticated customer id, so
// guests simply can't use them — see /api/checkout/create-session. This layout
// intentionally does NOT force a login (that previously blocked guest checkout).
export default function CheckoutLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
