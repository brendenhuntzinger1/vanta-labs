import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { getCoaLibrarySnapshot } from "@/lib/coa";
import type { CoaLibrarySnapshot } from "@/lib/coa-types";
import { CoaLibraryPageClient } from "./coa-library-client";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// NOINDEX, because this page names the catalogue.
//
// The library lists compounds — GLP-1, GLP-2, GLP-3, BPC-157 and Retatrutide
// were all in its signed-out HTML, measured 2026-09-05 — so leaving it open
// would publish the product list from the one page nobody thought of as a
// product page. Retatrutide is the tell: it appears here and is not in the
// products table at all, so this page was leaking compounds the shop does not
// even sell.
//
// The description is deliberately about the PROGRAMME rather than the
// compounds, so that a stale search result or a link preview says nothing the
// gate is meant to withhold.
export const metadata: Metadata = {
  ...pageMetadata({
    path: "/coa-library",
    title: "Certificates of Analysis",
    description:
      "Every batch Vanta Labs ships is independently tested, and the full certificate is available to account holders.",
  }),
  robots: { index: false, follow: false },
};

const EMPTY_SNAPSHOT: CoaLibrarySnapshot = {
  products: [],
  documentedProductCount: 0,
  totalDocumentCount: 0,
  hasLabAttribution: false,
  hasIdentityVerification: false,
};

export default async function Page() {
  // Batch and test data require an account, like the catalogue it documents.
  // Middleware refuses this path first (GATED_PREFIXES in middleware.ts); this
  // is the layer that makes sure the snapshot is never READ for a signed-out
  // request, because reading it would serialise every compound and lot number
  // into the RSC payload whether or not the markup rendered them.
  const viewer = await getAuthenticatedUser().catch(() => null);
  if (!viewer) {
    redirect("/account/login?next=%2Fcoa-library");
  }

  // Rendered on the server so the grid is in the first paint — the old page
  // fetched its records from the client, which meant a blank library for the
  // length of a round trip on exactly the page people arrive at skeptical.
  //
  // A database hiccup degrades to the "archive is being prepared" state rather
  // than an error page: a COA library that 500s reads as something to hide.
  const snapshot = await getCoaLibrarySnapshot().catch((error) => {
    console.error("COA library: unable to build snapshot", error);
    return EMPTY_SNAPSHOT;
  });

  return <CoaLibraryPageClient snapshot={snapshot} />;
}
