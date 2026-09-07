/**
 * One spend feed for four ad platforms.
 *
 * Windsor.ai normalises several ad platforms behind one REST endpoint, which is
 * why this file is one client rather than four, with four OAuth dances, four
 * pagination styles and four rate limiters.
 *
 * WHICH platforms are requested is NOT this list — see activeWindsorConnectors
 * below. Asking for one the account has not attached takes the whole feed down.
 *
 * ══ EVERY FIELD NAME BELOW WAS READ BACK FROM THE LIVE API. ══
 *
 * This is not a style note. Windsor does not reject an unknown field — it
 * OMITS the column. A wrong name therefore produces a row that parses cleanly
 * with that value silently null, forever, and the system reports itself
 * healthy while ingesting incomplete data. The first version of this file had
 * four such names:
 *
 *   tiktok   adgroup_id/adgroup_name  ->  ad_group_id/ad_group_name
 *   reddit   adgroup_id/adgroup_name  ->  ad_group_id/ad_group_name
 *   snapchat adsquad_id/adsquad_name  ->  ad_squad_id/ad_squad_name
 *   reddit   (assumed no landing URL) ->  ad_click_url exists
 *
 * The Reddit one was the expensive mistake: believing it exposed no destination
 * URL meant believing Reddit ads could never be auto-attributed to a creative,
 * which is wrong and would have sent the owner off to hand-name every ad.
 *
 * So: NO GUESSED ALIASES, and no fallback chains. A fallback that tries three
 * names and takes whichever answers is the same silent failure wearing a
 * seatbelt — it hides which name was right. One verified name per field, pinned
 * by windsor-fields.test.ts.
 *
 * TO ADD OR CHANGE A FIELD: call Windsor's own field list for that connector,
 * confirm the id comes back, then change BOTH the map and the test.
 *
 * WHAT THIS FILE DOES NOT DO: decide anything. It fetches and normalises.
 * Windowing, idempotency and persistence live in `spend-ingest.ts`, so all of
 * that is testable without a network.
 */

import { adPlatformKey, isSafeTag, parseAdTagsFromUrl } from "./utm";

export const WINDSOR_ENDPOINT = "https://connectors.windsor.ai";

/** Connector slugs, as Windsor spells them. `facebook` covers Instagram too. */
/** Every connector this client knows how to read. NOT the list it asks for. */
export const WINDSOR_CONNECTORS = ["facebook", "tiktok", "reddit", "snapchat"] as const;
export type WindsorConnector = (typeof WINDSOR_CONNECTORS)[number];

/** What this account actually has attached. Override with WINDSOR_CONNECTORS. */
export const DEFAULT_WINDSOR_CONNECTORS = ["facebook", "tiktok", "snapchat"] as const;

/**
 * ASKING FOR A CONNECTOR THE ACCOUNT HAS NOT CONNECTED TAKES DOWN THE WHOLE FEED.
 *
 * This used to be one list doing two jobs: the connectors this code can parse,
 * and the connectors it requests every night. That is fine while every platform
 * is attached and actively wrong otherwise, because Windsor bills by DATA
 * SOURCE and counts a request for an unattached one against the plan.
 *
 * Measured against the live account on 2026-09-06. Three sources were
 * connected — facebook, tiktok, snapchat — on a plan that allows three. We
 * asked for four. Windsor answered every one of them, including the three that
 * were connected and paid for, with:
 *
 *   "Uh-oh! You've connected more data sources than your Basic plan allows.
 *    Upgrade here: https://onboard.windsor.ai/app/manage-subscription"
 *
 * HTTP 200, a data array, that sentence in every text field and 0 in every
 * number. So one unconnected platform in this list cost the store its entire
 * spend feed — $11.33 of real TikTok spend that day recorded as $0.00 — and
 * the notice reads as an instruction to spend money upgrading, which would not
 * have fixed it either.
 *
 * The owner's own count is the authority on what is attached, so the default is
 * the three that are, and the environment variable is what changes it without a
 * deploy when a platform is added or dropped.
 */
export function activeWindsorConnectors(
  raw: string | undefined = process.env.WINDSOR_CONNECTORS,
): readonly WindsorConnector[] {
  const configured = String(raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is WindsorConnector => (WINDSOR_CONNECTORS as readonly string[]).includes(name));
  // De-duplicated: asking twice would double-count against the plan.
  const unique = [...new Set(configured)];
  return unique.length > 0 ? unique : DEFAULT_WINDSOR_CONNECTORS;
}

/**
 * Windsor's plan-limit notice, which arrives as DATA rather than as an error.
 *
 * Matched on the sentence rather than a status code, for the same reason
 * isNotConnectedResponse is: the status is Windsor's to change and the wording
 * is what identifies the condition. Deliberately narrow — "Basic plan" alone
 * would match an ad named after a pricing tier.
 */
export function isPlanLimitNotice(text: string): boolean {
  return /connected more data sources than your/i.test(text)
    || /onboard\.windsor\.ai\/app\/manage-subscription/i.test(text);
}

/**
 * Per-connector field names, all verified against the live API.
 *
 * `destinationUrl: null` for Snapchat is a fact about the platform, not a gap to
 * paper over: Snapchat exposes no landing URL through this connector, so its ads
 * cannot be auto-attributed to a creative and must instead be NAMED for their
 * `utm_content`. Saying so plainly is what lets the dashboard explain the blind
 * spot rather than just showing a smaller number.
 *
 * `conversions` / `conversionValue` are the PLATFORM'S OWN counts. They are
 * stored beside ours and never mixed into ROAS — each platform counts under its
 * own attribution model and they will disagree with our order table.
 */
export type FieldMap = {
  /** Ad group / ad set / ad squad — each platform's middle tier, whatever it calls it. */
  adgroupId: string;
  adgroupName: string;
  /** The ad's destination URL, or null where the connector exposes none. */
  destinationUrl: string | null;
  /** The platform's own purchase count. */
  conversions: string;
  /** The platform's own purchase value, or null where none is exposed. */
  conversionValue: string | null;
};

export const FIELDS: Record<WindsorConnector, FieldMap> = {
  facebook: {
    adgroupId: "adset_id",
    adgroupName: "adset_name",
    destinationUrl: "link_url",
    conversions: "actions_purchase",
    conversionValue: "action_values_purchase",
  },
  tiktok: {
    adgroupId: "ad_group_id",
    adgroupName: "ad_group_name",
    destinationUrl: "landing_page_url",
    conversions: "complete_payment",
    // Windsor's own label for this id is "Purchase value (website)". The id
    // reads like a rate; it is not. Verified from the connector's field list.
    conversionValue: "total_complete_payment_rate",
  },
  reddit: {
    adgroupId: "ad_group_id",
    adgroupName: "ad_group_name",
    destinationUrl: "ad_click_url",
    // Click-attributed purchases only. Reddit reports click and view conversions
    // separately (conversion_purchase_views is the other half); counting both
    // would credit an impression nobody clicked, which is precisely the
    // over-crediting this system exists to avoid.
    conversions: "conversion_purchase_clicks",
    conversionValue: "purchase_total_value",
  },
  snapchat: {
    adgroupId: "ad_squad_id",
    adgroupName: "ad_squad_name",
    destinationUrl: null,
    conversions: "conversion_purchases",
    conversionValue: "conversion_purchases_value",
  },
};

/** Fields every connector has. Verified present on all four. */
export const COMMON_FIELDS = [
  "date",
  "campaign",
  "campaign_id",
  "ad_id",
  "ad_name",
  "spend",
  "clicks",
  "impressions",
] as const;

export function fieldsFor(connector: WindsorConnector): string[] {
  const map = FIELDS[connector];
  return [
    ...COMMON_FIELDS,
    map.adgroupId,
    map.adgroupName,
    map.destinationUrl,
    map.conversions,
    map.conversionValue,
  ].filter((f): f is string => typeof f === "string");
}

/** A normalised spend row, matching `ad_spend_daily` one-to-one. */
export type SpendRow = {
  platform: string;
  adId: string;
  statDate: string;
  campaignId: string | null;
  campaignName: string | null;
  adgroupId: string | null;
  adgroupName: string | null;
  adName: string | null;
  landingUrl: string | null;
  utmContent: string | null;
  utmCampaign: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  /** The platform's own purchase count. Null means it reported none at all. */
  platformConversions: number | null;
  platformConversionValue: number | null;
  currency: string;
};

export type RowRejection = { reason: string; row: unknown };

/**
 * Numbers arrive as strings, as nulls, as "0.00", and occasionally with commas.
 *
 * A value that cannot be read becomes null, never 0. Zero is a real measurement
 * — an ad that spent nothing — and conflating "no spend" with "we failed to
 * parse the spend" is how a broken feed reads as a cheap campaign.
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** `2026-09-06`, `2026-09-06T00:00:00Z` and `2026/09/06` all mean the same day. */
export function toStatDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(trimmed);
  if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;
  return null;
}

// Written as explicit \u escapes rather than a literal character range: the
// literal form is invisible in a diff and corrupts in transit, and this is what
// stands between a platform-supplied ad name and the database.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function toText(raw: unknown, max = 512): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/** A count that must stay distinguishable from "not reported". */
function toCount(raw: unknown): number | null {
  const n = toNumber(raw);
  if (n === null) return null;
  return Math.max(0, Math.trunc(n));
}

/**
 * Turn one raw Windsor row into a `SpendRow`, or say why it cannot be.
 *
 * REJECTS RATHER THAN GUESSES on the three fields that must be right: a row
 * with no ad id has no primary key, a row with no readable date cannot be
 * placed in time, and a row whose spend will not parse would understate cost.
 * Everything else is optional and absent means absent — a connector that omits
 * ad-group names or conversions still yields a usable spend row, because
 * refusing the whole row would lose real money data over a missing label.
 *
 * Rejections are returned, not thrown and not logged-and-dropped, so the ingest
 * can report how much it refused.
 */
export function normalizeSpendRow(
  connector: WindsorConnector,
  raw: unknown,
  options: { currency?: string } = {},
): { ok: true; row: SpendRow } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "row is not an object" };
  const r = raw as Record<string, unknown>;
  const map = FIELDS[connector];

  const adId = toText(r.ad_id, 128);
  if (!adId) return { ok: false, reason: "missing ad_id" };
  // AN AD ID IS A TOKEN. A SENTENCE IN THIS FIELD IS THE FEED TALKING TO US.
  //
  // Windsor answers an account-level problem with HTTP 200 and a data array
  // whose every TEXT field carries the SAME prose, and whose every numeric
  // field is 0. Measured against the live account on 2026-09-06, all four
  // connectors returned exactly this:
  //
  //   {"date":"2026-09-06",
  //    "ad_id":"Uh-oh! You've connected more data sources than your Basic plan
  //             allows. Upgrade here: https://onboard.windsor.ai/...",
  //    "ad_name":<the same sentence>, "spend":0, "clicks":0, "impressions":0}
  //
  // Every check below passed on that row: the id was non-empty, the date
  // parsed, and 0 is a perfectly good spend. So a 128-character prefix of an
  // error message was about to be written into ad_spend_daily as an ad, the
  // ingest was about to report `status: "ok"`, and the "every connector failed"
  // alarm — the one added precisely so a broken feed could not read as a quiet
  // one — was never going to fire, because nothing had failed.
  //
  // Whitespace is the discriminator, and it is exact rather than clever: Meta
  // and TikTok ad ids are digit strings, Snapchat's are UUIDs and Reddit's are
  // short alphanumerics with underscores. Not one platform's id can contain a
  // space, so this rejects the notice and can never reject an ad.
  if (/\s/.test(adId)) {
    return { ok: false, reason: `ad_id is not an identifier: ${JSON.stringify(adId.slice(0, 160))}` };
  }

  const statDate = toStatDate(r.date);
  if (!statDate) return { ok: false, reason: `unparseable date ${JSON.stringify(r.date)}` };

  const spend = toNumber(r.spend);
  if (spend === null) return { ok: false, reason: `unparseable spend ${JSON.stringify(r.spend)}` };
  if (spend < 0) return { ok: false, reason: `negative spend ${spend}` };

  const landingUrl = map.destinationUrl ? toText(r[map.destinationUrl], 2048) : null;
  const tags = parseAdTagsFromUrl(landingUrl);

  // THE DOCUMENTED CONVENTION, IMPLEMENTED. See the FieldMap note above: a
  // connector that exposes no landing URL (Snapchat) can only be attributed to
  // a creative by NAMING the ad for its utm_content. That instruction has been
  // in this file since it was written and nothing acted on it, so every
  // Snapchat dollar was permanently untagged — the worst of both, because an
  // owner reading the comment would believe the convention worked.
  //
  // ONLY WHEN THE NAME IS ALREADY A VALID TAG. `isSafeTag`, not `toSafeTag`: a
  // name that has to be MANGLED into a tag ("Snap Video 3 — Winter") is a name,
  // not a deliberate tag, and coercing it would invent a join key that matches
  // no revenue. That would be worse than untagged: it turns invisible spend
  // into a creative row that looks like a failing ad. An operator who follows
  // the convention writes `hook_a` and it works; one who does not stays in the
  // untagged panel, which is honest.
  const nameAsTag = !landingUrl && !tags.utmContent && isSafeTag(toText(r.ad_name))
    ? toText(r.ad_name)
    : null;

  return {
    ok: true,
    row: {
      platform: adPlatformKey(connector) ?? connector,
      adId,
      statDate,
      campaignId: toText(r.campaign_id, 128),
      campaignName: toText(r.campaign),
      adgroupId: toText(r[map.adgroupId], 128),
      adgroupName: toText(r[map.adgroupName]),
      adName: toText(r.ad_name),
      landingUrl,
      utmContent: tags.utmContent ?? nameAsTag,
      utmCampaign: tags.utmCampaign,
      // Missing impressions and clicks are normal on a day with no delivery, so
      // they floor at 0; conversions stay null when unreported, because "the
      // platform says zero purchases" and "the platform has no pixel" are
      // different facts and the dashboard shows them differently.
      spend,
      impressions: Math.max(0, Math.trunc(toNumber(r.impressions) ?? 0)),
      clicks: Math.max(0, Math.trunc(toNumber(r.clicks) ?? 0)),
      platformConversions: toCount(r[map.conversions]),
      platformConversionValue: map.conversionValue ? toNumber(r[map.conversionValue]) : null,
      currency: options.currency ?? "USD",
    },
  };
}

export type FetchOutcome =
  | { ok: true; rows: SpendRow[]; rejections: RowRejection[];
      /** Windsor's own reply, truncated, when it returned NO rows. An empty
       *  window and a window we asked for wrongly look identical from the
       *  outside; this is the only thing that tells them apart. */
      emptySample?: string }
  /**
   * `notConnected` separates "this platform is not attached to the Windsor
   * account" from "the feed is broken", and the two need opposite responses.
   * See isNotConnectedResponse.
   */
  | { ok: false; error: string; notConnected?: boolean };

/**
 * Windsor saying "this platform is not attached to your account".
 *
 * A DISCONNECTED PLATFORM IS NOT A BROKEN FEED, AND THE COST OF CONFUSING THEM
 * IS A PERMANENT FALSE ALARM. Verified live on 2026-09-06, minutes after
 * Snapchat was detached from this store's Windsor account:
 *
 *     No snapchat account for user … was found, add your accounts at
 *     https://onboard.windsor.ai?datasource=snapchat
 *
 * That is an ERROR, not an empty result — so every nightly run would have
 * reported a failed connector for as long as the platform stayed detached, and
 * an operator would learn to ignore the one signal that says the feed is down.
 *
 * WINDSOR_CONNECTORS deliberately still lists snapchat. Detaching a platform is
 * an ordinary marketing decision and is usually temporary; reattaching it must
 * not require a deploy. A connector nobody has connected is simply skipped, and
 * starts working again the moment an account appears behind it.
 *
 * Matched on the message rather than the status code, because the status is
 * Windsor's to change and the sentence is what identifies the condition.
 */
function isNotConnectedResponse(detail: string): boolean {
  return /no\s+\w+\s+account for user/i.test(detail)
    || /onboard\.windsor\.ai\?datasource=/i.test(detail);
}

/**
 * Fetch one connector's daily spend for a date range.
 *
 * `fetchImpl` is injected so the ingest can be tested end to end without a
 * network and without a live API key.
 */
export async function fetchConnectorSpend(input: {
  connector: WindsorConnector;
  apiKey: string;
  dateFrom: string;
  dateTo: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<FetchOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = new URL(`${WINDSOR_ENDPOINT}/${input.connector}`);
  url.searchParams.set("api_key", input.apiKey);
  url.searchParams.set("date_from", input.dateFrom);
  url.searchParams.set("date_to", input.dateTo);
  url.searchParams.set("fields", fieldsFor(input.connector).join(","));

  let response: Response;
  try {
    response = await doFetch(url.toString(), { signal: input.signal });
  } catch (error) {
    return { ok: false, error: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    // The body carries Windsor's own explanation (an expired connector, a
    // revoked ad-account grant). Passing it through beats "HTTP 400", because
    // the fix differs for each and an operator reads this at 2am.
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      /* a body we cannot read is still an HTTP status worth reporting */
    }
    if (isNotConnectedResponse(detail)) {
      return { ok: false, notConnected: true, error: `${input.connector} is not connected to this Windsor account` };
    }
    return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
  }

  // READ THE BODY AS TEXT FIRST, then parse. A body can only be read once, and
  // Windsor's detached-account message arrives as a bare sentence — not JSON —
  // sometimes under a 200. Parsing first threw that away as "response was not
  // JSON", which is true and useless.
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    return { ok: false, error: `response body unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (isNotConnectedResponse(bodyText)) {
    return { ok: false, notConnected: true, error: `${input.connector} is not connected to this Windsor account` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    return { ok: false, error: `response was not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  // Windsor documents `{ data: [...] }`; a bare array is accepted too.
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : null;
  // A JSON-shaped variant of the same message (e.g. {"error": "No … account
  // for user …"}) — the text check above covers the bare-sentence form.
  if (!raw) {
    if (isNotConnectedResponse(JSON.stringify(payload ?? ""))) {
      return { ok: false, notConnected: true, error: `${input.connector} is not connected to this Windsor account` };
    }
    return { ok: false, error: "response carried no data array" };
  }

  const rows: SpendRow[] = [];
  const rejections: RowRejection[] = [];
  for (const item of raw) {
    const outcome = normalizeSpendRow(input.connector, item);
    if (outcome.ok) rows.push(outcome.row);
    else rejections.push({ reason: outcome.reason, row: item });
  }

  // A QUIET DAY AND A BROKEN FEED ARE DIFFERENT ANSWERS.
  //
  // An empty `data` array is a real, ordinary result: the connector answered
  // and there was no spend in the window. That stays `ok` with zero rows, and
  // must, or a paused account would alarm every night.
  //
  // Rows that ARRIVED and were all refused is the opposite: the connector said
  // something and none of it was ad data. That is the shape Windsor's
  // account-level notice takes (see normalizeSpendRow above), and it is also
  // what a schema change or a corrupted feed would look like. Reporting it as
  // success is how a broken feed becomes an empty dashboard with no alert, so
  // it is reported as a connector failure and carries the first reason
  // verbatim — an operator reading this at 2am needs Windsor's own words, not
  // "0 rows written".
  if (rows.length === 0 && rejections.length > 0) {
    // NAME THE ONE CONDITION WE HAVE ACTUALLY SEEN, because its cause is on OUR
    // side and the generic message sends you to Windsor's dashboard instead.
    //
    // Measured 2026-09-06: every connector returned the plan-limit notice, and
    // the account had exactly the three sources its plan allows connected
    // (facebook, tiktok, snapchat). The fourth request was ours —
    // WINDSOR_CONNECTORS asks for `reddit` as well — and asking for a source
    // the account has not connected is what trips the limit. Windsor then
    // returns the notice for EVERY connector in the run, so one unconnected
    // platform in our list takes the whole spend feed down.
    //
    // "Upgrade your plan" is therefore the wrong instruction and an expensive
    // one to follow. The fix is to ask only for what the account has, which is
    // what the WINDSOR_CONNECTORS environment variable is for.
    const planLimit = rejections.find((r) => isPlanLimitNotice(r.reason));
    if (planLimit) {
      return {
        ok: false,
        // WINDSOR'S OWN WORDS STAY IN, and the explanation is added AFTER them
        // rather than in place of them. The rule this file already follows —
        // "an operator reading this at 2am needs Windsor's own words, not '0
        // rows written'" — is not weakened by knowing what to do about it, and
        // replacing the verbatim notice would leave nothing to search for.
        error:
          `Windsor returned its plan-limit notice instead of data for ${input.connector} — ${planLimit.reason}. `
          + "This is usually caused by requesting a connector the account has not connected: "
          + "the extra request itself counts against the plan, and Windsor then returns this "
          + "for EVERY connector, not just the missing one. Set WINDSOR_CONNECTORS to the "
          + `connectors this account actually has (currently asking for: ${activeWindsorConnectors().join(", ")}).`,
      };
    }
    return {
      ok: false,
      error: `${rejections.length} row(s) returned, none usable — ${rejections[0].reason}`,
    };
  }

  // NOTHING CAME BACK. Say what Windsor actually replied, once, rather than
  // reporting a clean zero that could equally mean "no spend that week" or
  // "you asked for the wrong thing". Ad reporting, not customer data.
  if (rows.length === 0 && rejections.length === 0) {
    return { ok: true, rows, rejections, emptySample: bodyText.slice(0, 300) };
  }
  return { ok: true, rows, rejections };
}
