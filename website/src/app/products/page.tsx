import type { Metadata } from "next";
import { ProductsPageClient } from "./products-client";

export const metadata: Metadata = {
  title: "Research Peptides Catalog",
  description:
    "Browse Vanta Labs' catalog of premium, third-party tested research compounds with batch-matched COAs and transparent purity records.",
};

export default function Page() {
  return <ProductsPageClient />;
}
