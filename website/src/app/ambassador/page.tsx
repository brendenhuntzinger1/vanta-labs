import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { getPublicProgramTerms } from "@/lib/public-program-terms";
import { AmbassadorPageClient } from "./ambassador-client";

export const metadata: Metadata = pageMetadata({
  path: "/ambassador",
  title: "Ambassador Program",
  description:
    "Join the Vanta Labs Ambassador Program and earn commissions referring researchers to premium, third-party tested research compounds.",
});

// Dynamic because the numbers on this page are the live programme terms. A
// statically cached copy would go on promising the old rate after the owner
// changed it in the Control Center -- the exact drift this wiring removes.
export const dynamic = "force-dynamic";

export default async function Page() {
  const terms = await getPublicProgramTerms();
  return <AmbassadorPageClient terms={terms} />;
}
