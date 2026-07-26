import { ReactNode } from "react";
import type { Metadata } from "next";

// The vault is a hidden admin entry point — keep it out of search indexes even
// if the URL leaks (the page itself is a client component and can't export
// metadata, so the noindex lives here in the co-located layout).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function VaultLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
