import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto flex max-w-2xl flex-col items-center px-4 pb-24 pt-40 text-center sm:px-6 lg:pt-48">
        <p className="vl2-eyebrow text-white/50">Error 404</p>
        <h1 className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Page not found</h1>
        <p className="mt-4 max-w-md text-sm leading-7 text-white/60 sm:text-base">
          The page you&apos;re looking for doesn&apos;t exist or may have moved. Let&apos;s get you back to the research.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/products" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">
            Browse products
          </Link>
          <Link href="/" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">
            Go home
          </Link>
        </div>
      </main>
    </div>
  );
}
