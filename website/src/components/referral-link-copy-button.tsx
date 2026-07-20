"use client";

import { useState } from "react";

export function ReferralLinkCopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the link
      // text is still visible to copy manually.
    }
  };

  return (
    <button type="button" onClick={handleCopy} className="vl-btn-secondary px-3 py-1.5 text-xs">
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
