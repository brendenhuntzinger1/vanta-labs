import { describe, expect, it } from "vitest";
import { isLikelyBotUserAgent } from "./bot-detection";

// ---------------------------------------------------------------------------
// This is a display filter for one internal dashboard (/admin/live), not an
// access control — see the header comment on bot-detection.ts. The bar is
// "obvious": a plain substring/regex match against known crawler and
// scripted-client user agents, not a fingerprinting system.
// ---------------------------------------------------------------------------

describe("isLikelyBotUserAgent", () => {
  it("flags well-known search/social crawlers", () => {
    expect(isLikelyBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(
      true,
    );
    expect(isLikelyBotUserAgent("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(
      true,
    );
    expect(isLikelyBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isLikelyBotUserAgent("Twitterbot/1.0")).toBe(true);
    expect(isLikelyBotUserAgent("Slackbot-LinkExpanding 1.0")).toBe(true);
  });

  it("flags headless browsers and scraping tools", () => {
    expect(isLikelyBotUserAgent("Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36")).toBe(true);
    expect(isLikelyBotUserAgent("Mozilla/5.0 (compatible; PhantomJS/2.1.1)")).toBe(true);
    expect(isLikelyBotUserAgent("python-requests/2.31.0")).toBe(true);
    expect(isLikelyBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isLikelyBotUserAgent("Scrapy/2.11 (+https://scrapy.org)")).toBe(true);
  });

  it("flags SEO/marketing crawlers", () => {
    expect(isLikelyBotUserAgent("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)")).toBe(true);
    expect(isLikelyBotUserAgent("Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)")).toBe(
      true,
    );
  });

  it("does not flag ordinary browsers", () => {
    expect(
      isLikelyBotUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isLikelyBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(
      isLikelyBotUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe(false);
  });

  it("treats a missing or empty user agent as not-a-bot (nothing to match)", () => {
    expect(isLikelyBotUserAgent(null)).toBe(false);
    expect(isLikelyBotUserAgent(undefined)).toBe(false);
    expect(isLikelyBotUserAgent("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isLikelyBotUserAgent("GOOGLEBOT/2.1")).toBe(true);
    expect(isLikelyBotUserAgent("Some-Custom-BOT-v3")).toBe(true);
  });
});
