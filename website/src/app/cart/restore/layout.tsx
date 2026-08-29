import { ReactNode } from "react";
import type { Metadata } from "next";

// Reached from a per-recipient abandoned-cart email link, and it MUTATES state
// on arrival: it reads ?id=, calls /api/cart/restore and writes those items
// into the visitor's cart.
//
// It was served as "index, follow". Nothing but robots.txt stood between this
// route and the index — and robots.txt Disallow prevents crawling, not
// indexing, so a link to one of these URLs from anywhere public could have
// listed it. /cart above it carries a noindex, but page metadata does not
// cascade to a child route; only layouts do, and there was no layout here.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CartRestoreLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
