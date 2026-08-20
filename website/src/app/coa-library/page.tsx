import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { getCoaLibrarySnapshot } from "@/lib/coa";
import type { CoaLibrarySnapshot } from "@/lib/coa-types";
import { CoaLibraryPageClient } from "./coa-library-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  path: "/coa-library",
  title: "Certificates of Analysis",
  description:
    "Third-party testing and batch documentation for Vanta Labs research compounds. Search by product, batch, or lot number and open the full Certificate of Analysis.",
});

const EMPTY_SNAPSHOT: CoaLibrarySnapshot = {
  products: [],
  documentedProductCount: 0,
  totalDocumentCount: 0,
  hasLabAttribution: false,
  hasIdentityVerification: false,
};

export default async function Page() {
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
