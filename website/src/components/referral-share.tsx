"use client";

import { useState } from "react";

/**
 * Referral share tools for ambassadors: native share sheet + one-tap share to
 * X, Facebook, Email, and SMS (real URL intents), plus copy-caption for
 * Instagram/TikTok (which have no web post intent). All client-side.
 */
export function ReferralShare({ referralLink, code }: { referralLink: string; code: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const caption = `I use Vanta Labs for premium research compounds — quality tested, transparent COAs. Use my link${code ? ` (code ${code})` : ""} to shop:`;
  const enc = encodeURIComponent;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      setCopied(null);
    }
  };

  const nativeShare = async () => {
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: "Vanta Labs", text: caption, url: referralLink });
      } catch {
        /* user dismissed */
      }
    } else {
      copy(`${caption} ${referralLink}`, "native");
    }
  };

  const targets: Array<{ key: string; label: string; onClick: () => void; icon: React.ReactElement }> = [
    {
      key: "x",
      label: "X",
      onClick: () => window.open(`https://twitter.com/intent/tweet?text=${enc(caption)}&url=${enc(referralLink)}`, "_blank", "noopener"),
      icon: <span className="text-sm font-bold">𝕏</span>,
    },
    {
      key: "facebook",
      label: "Facebook",
      onClick: () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${enc(referralLink)}`, "_blank", "noopener"),
      icon: <span className="text-sm font-bold">f</span>,
    },
    {
      key: "instagram",
      label: "Instagram",
      onClick: () => copy(`${caption} ${referralLink}`, "instagram"),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-4 w-4" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="3.4" /><circle cx="17" cy="7" r="0.6" fill="currentColor" />
        </svg>
      ),
    },
    {
      key: "tiktok",
      label: "TikTok",
      onClick: () => copy(`${caption} ${referralLink}`, "tiktok"),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <path d="M14 4v9.5a3.5 3.5 0 1 1-3-3.46" /><path d="M14 6.5A4.5 4.5 0 0 0 18.5 9" />
        </svg>
      ),
    },
    {
      key: "email",
      label: "Email",
      onClick: () => window.open(`mailto:?subject=${enc("Thought you'd like Vanta Labs")}&body=${enc(`${caption}\n\n${referralLink}`)}`),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" />
        </svg>
      ),
    },
    {
      key: "sms",
      label: "SMS",
      onClick: () => window.open(`sms:?&body=${enc(`${caption} ${referralLink}`)}`),
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <path d="M4 5h16v11H8l-4 4z" />
        </svg>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={nativeShare}
          className="vl2-btn-primary vl-focus-ring inline-flex items-center gap-2 px-4 py-2.5 text-xs"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
          </svg>
          Share
        </button>
        {targets.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={t.onClick}
            aria-label={`Share on ${t.label}`}
            title={t.label}
            className="vl-focus-ring flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/[0.03] text-zinc-200 transition-colors duration-200 hover:border-white/35 hover:text-white"
          >
            {t.icon}
          </button>
        ))}
      </div>
      {copied ? (
        <p className="mt-2 text-xs text-emerald-300">
          {copied === "instagram" || copied === "tiktok"
            ? `Caption + link copied — paste it into your ${copied === "instagram" ? "Instagram" : "TikTok"} post or bio.`
            : "Copied to clipboard."}
        </p>
      ) : null}
    </div>
  );
}
