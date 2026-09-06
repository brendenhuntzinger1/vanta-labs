import { describe, it, expect } from "vitest";
import { parseAttributionTouch, sanitizeAttributionRecord } from "@/lib/attribution";
import { parseAdTagsFromUrl } from "@/lib/ads/utm";

describe("join keys", () => {
  it("working-tree capture vs spend", () => {
    const t = parseAttributionTouch({ search: "?utm_source=TikTok&utm_content=Hook_A", now: new Date() });
    const s = parseAdTagsFromUrl("https://x/?utm_source=TikTok&utm_content=Hook_A");
    console.log("CASE  capture:", t?.utmContent, "| spend:", s.utmContent);
    expect(t?.utmContent).toBe(s.utmContent);
  });
  it("unsafe tag", () => {
    const t = parseAttributionTouch({ search: "?utm_source=tiktok&utm_content=Hook%20A", now: new Date() });
    const s = parseAdTagsFromUrl("https://x/?utm_source=tiktok&utm_content=Hook%20A");
    console.log("UNSAFE capture:", JSON.stringify(t?.utmContent), "| spend:", JSON.stringify(s.utmContent));
  });
});
