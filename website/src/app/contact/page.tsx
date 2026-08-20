import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { ContactPageClient } from "./contact-client";

export const metadata: Metadata = pageMetadata({
  path: "/contact",
  title: "Contact Us",
  description:
    "Get in touch with Vanta Labs research support for questions about your order, products, shipping, or general inquiries.",
});

export default function Page() {
  return <ContactPageClient />;
}
