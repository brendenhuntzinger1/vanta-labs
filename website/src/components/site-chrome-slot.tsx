"use client";

import { usePathname } from "next/navigation";
import { SiteFooter } from "@/components/site-footer";

/**
 * THE STOREFRONT FOOTER, EVERYWHERE EXCEPT THE FRONT DOOR.
 *
 * The access portal is the one page whose whole job is to be the only thing on
 * screen. The site header was already removed from it; the footer was not, so
 * underneath the gate sat a full storefront menu — All Products, COA Library,
 * Cart — every one of which bounces a signed-out visitor straight back to the
 * page they are already on. Measured at 390x844: the portal itself is about one
 * screen, and the footer took the document to 2,294px, 3.3 screens, with the
 * gate occupying the first third and dead links occupying the rest.
 *
 * It also cost real requests. Next prefetches the links in view, so every load
 * of the sign-in page fired five prefetches of gated routes and collected five
 * 307s for its trouble.
 *
 * NOT RENDERED, NOT HIDDEN. This is a client component only because it needs
 * the pathname; it is server-rendered like any other, so on these routes the
 * footer is absent from the HTML rather than present and covered. The
 * distinction is the same one the access policy turns on, and it is worth
 * keeping even where the content is only a menu.
 */
const CHROMELESS = [
  "/account/login",
  "/account/forgot-password",
  "/account/reset-password",
  "/account/auth/callback",
  "/auth/confirm",
];

export function SiteFooterSlot() {
  const pathname = usePathname();
  if (CHROMELESS.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }
  return <SiteFooter />;
}
