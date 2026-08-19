import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Which build is this? Inlined at build time so a page can say out loud what
  // it is running. The whole point is to settle "is the in-app browser even
  // getting the new deployment?" without guessing — an in-app webview cannot be
  // attached to a debugger, so the page has to be able to answer for itself.
  //
  // A short commit SHA and a timestamp. Neither is a secret; both are already
  // public in the repository.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.NEXT_PUBLIC_BUILD_ID ??
      "local",
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  images: {
    // Pin the image optimizer to the CDNs we actually serve product/COA images
    // from (Supabase Storage + our image CDN) instead of a wildcard host. A
    // wildcard turns the optimizer into an open image proxy (SSRF / bandwidth
    // abuse); these patterns cover every real image source.
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.cloudfront.net" },
    ],
  },
};

export default nextConfig;
