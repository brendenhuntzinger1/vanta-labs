/**
 * "Obvious bot" classification for the live-visitor dashboard ONLY.
 *
 * This is a display filter, not an access control. It never changes what is
 * served to a requester, never gates a route, and never varies behavior by
 * who is asking — unlike access-policy.ts's "uniform wall", which is a
 * different concern entirely (that guards against cloaking in what the SITE
 * serves). This only decides whether one internal dashboard, /admin/live,
 * counts a heartbeat toward "who's here right now". A false negative here
 * costs nothing but an inflated count on one admin screen; a false positive
 * costs the same. Neither should ever be allowed to affect anything a
 * customer experiences.
 *
 * Most real crawlers (Googlebot's default crawl, most SEO bots) never run
 * the client JS that sends a heartbeat at all, so they never reach this
 * function. This exists as a backstop for the minority that do execute JS —
 * headless browsers and scraping tools — via a plain, case-insensitive
 * substring/pattern match against known bot/scripted-client user agents.
 * "Obvious" is the bar, not exhaustive detection.
 */
const BOT_USER_AGENT_PATTERN =
  /bot|spider|crawl|slurp|headless|phantomjs|selenium|puppeteer|playwright|scrapy|curl\/|wget|python-requests|python-urllib|go-http-client|java\/|okhttp|node-fetch|axios\/|libwww-perl|facebookexternalhit|embedly|whatsapp/i;

export function isLikelyBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) {
    return false;
  }
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}
