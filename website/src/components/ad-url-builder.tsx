"use client";

import { useMemo, useState } from "react";
import { AD_PLATFORMS, buildAdLandingUrl, toSafeTag } from "@/lib/ads/utm";

/**
 * Build the landing URL to paste into an ad platform, and say where it goes.
 *
 * This exists because the tagging is the ONE step of this whole system a person
 * has to do by hand, every time, in four different interfaces — and a tag typed
 * slightly wrong does not fail loudly. It produces an ad that spends money and
 * reports as untagged, which reads like the ad made nothing.
 *
 * So the rules are enforced here rather than written down and hoped for:
 * `buildAdLandingUrl` is the same function the ingest uses to read the tags back
 * out, so a URL this produces is one the pipeline can definitely parse. What you
 * copy is what will join.
 */

type Product = { slug: string; name: string };

const PLATFORM_FIELD: Record<string, string> = {
  facebook: "Ads Manager → your ad → Website URL",
  tiktok: "Ad → Destination page → URL",
  reddit: "Ad → Destination URL",
  snapchat: "Ad → Attachment → Website URL",
};

const PLATFORM_LABEL: Record<string, string> = {
  facebook: "Meta (Facebook + Instagram)",
  tiktok: "TikTok",
  reddit: "Reddit",
  snapchat: "Snapchat",
};

export function AdUrlBuilder({ siteUrl, products }: { siteUrl: string; products: Product[] }) {
  const [platform, setPlatform] = useState<string>("facebook");
  const [path, setPath] = useState<string>(products[0]?.slug ? `/products/${products[0].slug}` : "/products");
  const [campaign, setCampaign] = useState("launch");
  const [content, setContent] = useState("hook_a");
  const [copied, setCopied] = useState(false);

  const built = useMemo(
    () => buildAdLandingUrl({ baseUrl: siteUrl, path, tags: { platform, campaign, content } }),
    [siteUrl, path, platform, campaign, content],
  );

  async function copy() {
    if (!built.ok) return;
    try {
      await navigator.clipboard.writeText(built.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be denied. The URL is selectable on screen either way, so
      // this is a convenience, never the only route to the value.
      setCopied(false);
    }
  }

  const field = "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white outline-none focus:border-white/25";
  const labelClass = "mb-1 block text-[10px] uppercase tracking-[0.16em] text-white/35";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor="ad-url-platform">Platform</label>
          <select id="ad-url-platform" className={field} value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {AD_PLATFORMS.map((p) => (
              <option key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="ad-url-path">Landing page</label>
          <select id="ad-url-path" className={field} value={path} onChange={(e) => setPath(e.target.value)}>
            {/* Products first, and the default: an ad should land on the thing
                it is selling, not on a catalogue the visitor has to search. */}
            {products.map((p) => (
              <option key={p.slug} value={`/products/${p.slug}`}>{p.name}</option>
            ))}
            <option value="/products">All products</option>
            <option value="/">Home page</option>
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="ad-url-campaign">Campaign</label>
          <input
            id="ad-url-campaign"
            className={field}
            value={campaign}
            onChange={(e) => setCampaign(toSafeTag(e.target.value) ?? e.target.value.toLowerCase())}
            placeholder="launch"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="ad-url-content">Ad (one per creative)</label>
          <input
            id="ad-url-content"
            className={field}
            value={content}
            onChange={(e) => setContent(toSafeTag(e.target.value) ?? e.target.value.toLowerCase())}
            placeholder="hook_a"
          />
        </div>
      </div>

      {built.ok ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-3">
          <div className="flex items-start justify-between gap-3">
            <code className="min-w-0 break-all font-mono text-[11px] leading-5 text-emerald-200/90">{built.url}</code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/[0.08]"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-white/40">
            Paste into <span className="text-white/70">{PLATFORM_FIELD[platform] ?? "the ad's destination URL field"}</span>.
            {platform === "snapchat" ? (
              <>
                {" "}
                <span className="text-[color:var(--accent-gold)]/80">
                  Also name the ad <code className="font-mono">{content || "hook_a"}</code>
                </span>{" "}
                — Snapchat is the one platform that does not report its destination URL back, so the ad name is how it
                gets matched.
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <ul className="space-y-1 rounded-xl border border-red-400/25 bg-red-500/[0.06] p-3 text-[11px] text-red-200/90">
          {built.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
