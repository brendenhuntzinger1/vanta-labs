import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { AmbassadorPageClient } from "./ambassador-client";

export const metadata: Metadata = pageMetadata({
  path: "/ambassador",
  title: "Ambassador Program",
  description:
    "Join the Vanta Labs Ambassador Program and earn commissions referring researchers to premium, third-party tested research compounds.",
});

export default function Page() {
  return <AmbassadorPageClient />;
}
