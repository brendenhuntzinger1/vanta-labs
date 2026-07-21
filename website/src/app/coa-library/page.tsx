import type { Metadata } from "next";
import { CoaLibraryPageClient } from "./coa-library-client";

export const metadata: Metadata = {
  title: "COA Library",
  description:
    "Browse Vanta Labs Certificates of Analysis and third-party lab reports. Search batch documentation, purity results, and laboratory validation records.",
};

export default function Page() {
  return <CoaLibraryPageClient />;
}
