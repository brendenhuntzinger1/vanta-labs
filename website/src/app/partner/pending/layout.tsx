import { ReactNode } from "react";
import type { Metadata } from "next";

// A personalised application-status page: it renders "Pending Approval",
// "We Need a Bit More Information", "Application Not Approved" or "Partner
// Access Disabled" depending on who is asking. None of that belongs in a
// search result, and unlike /cart and /checkout this route is NOT in
// robots.txt's disallow set — production served it 200 with "index, follow"
// to an unauthenticated Googlebot fetch.
//
// `follow` is kept: the page's only links are back into the public site, and
// there is no reason to strand them.
//
// page.tsx is a Client Component, which cannot export metadata at all, so the
// directive lives in this co-located layout — the same shape vault/ and
// checkout/ already use.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function PartnerPendingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
