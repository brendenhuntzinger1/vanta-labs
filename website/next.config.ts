import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
