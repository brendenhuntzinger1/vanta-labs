import { describe, expect, it } from "vitest";

import {
  DEFAULT_WINDSOR_CONNECTORS,
  activeWindsorConnectors,
  isPlanLimitNotice,
} from "@/lib/ads/windsor-client";

// ---------------------------------------------------------------------------
// ONE UNCONNECTED PLATFORM TOOK DOWN THE WHOLE SPEND FEED.
//
// Windsor bills by data source and counts a request for an unattached one
// against the plan. The account had its three connected (facebook, tiktok,
// snapchat) on a plan allowing three; this code asked for four. Windsor
// answered EVERY connector — including the three that were connected and paid
// for — with its plan-limit notice, at HTTP 200, in a data array, that sentence
// in every text field and 0 in every number.
//
// So $11.33 of real TikTok spend on 2026-09-06 was recorded as $0.00, and the
// notice told the operator to upgrade, which would not have fixed it.
// ---------------------------------------------------------------------------

const NOTICE =
  "Uh-oh! You've connected more data sources than your Basic plan allows. "
  + "Upgrade here: https://onboard.windsor.ai/app/manage-subscription";

describe("which connectors we ask Windsor for", () => {
  it("defaults to the three the account actually has", () => {
    expect(activeWindsorConnectors(undefined)).toEqual(["facebook", "tiktok", "snapchat"]);
    expect(DEFAULT_WINDSOR_CONNECTORS).toEqual(["facebook", "tiktok", "snapchat"]);
  });

  it("does NOT ask for reddit by default — that request is what tripped the limit", () => {
    expect(activeWindsorConnectors(undefined)).not.toContain("reddit");
  });

  it("honours the environment variable, so attaching a platform is config not a deploy", () => {
    expect(activeWindsorConnectors("facebook,tiktok,snapchat,reddit"))
      .toEqual(["facebook", "tiktok", "snapchat", "reddit"]);
    expect(activeWindsorConnectors("tiktok")).toEqual(["tiktok"]);
  });

  it("tolerates spacing and casing, because an env var is typed by a human", () => {
    expect(activeWindsorConnectors(" TikTok , Facebook ")).toEqual(["tiktok", "facebook"]);
  });

  it("drops names this client cannot parse rather than requesting them", () => {
    // A typo must not cost a data source. "googlads" is not a connector here,
    // and asking for it would count against the plan exactly as reddit did.
    expect(activeWindsorConnectors("tiktok,googlads,,snapchat")).toEqual(["tiktok", "snapchat"]);
  });

  it("de-duplicates, because asking twice counts twice", () => {
    expect(activeWindsorConnectors("tiktok,tiktok,snapchat")).toEqual(["tiktok", "snapchat"]);
  });

  it("falls back to the default when the variable is set but yields nothing usable", () => {
    // An empty or all-invalid value must not mean "ask for nothing", which
    // would be a silently empty dashboard.
    expect(activeWindsorConnectors("")).toEqual([...DEFAULT_WINDSOR_CONNECTORS]);
    expect(activeWindsorConnectors("nonsense,alsononsense")).toEqual([...DEFAULT_WINDSOR_CONNECTORS]);
  });
});

describe("recognising the plan-limit notice", () => {
  it("matches the message the live account actually returned", () => {
    expect(isPlanLimitNotice(NOTICE)).toBe(true);
  });

  it("matches it wherever it appears, since it arrives inside a rejection reason", () => {
    expect(isPlanLimitNotice(`ad_id is not an identifier: ${JSON.stringify(NOTICE)}`)).toBe(true);
  });

  it("matches the upgrade link on its own", () => {
    expect(isPlanLimitNotice("see https://onboard.windsor.ai/app/manage-subscription")).toBe(true);
  });

  it("does NOT match an ad merely named after a pricing tier", () => {
    // The reason the match is on the whole phrase rather than "Basic plan":
    // a real ad called "Basic plan launch" must stay ingestable.
    expect(isPlanLimitNotice("Basic plan launch — creative A")).toBe(false);
    expect(isPlanLimitNotice("upgrade your data sources")).toBe(false);
  });

  it("does not match the DIFFERENT notice for a merely detached connector", () => {
    // That one is handled separately and is a skip, not a failure.
    expect(isPlanLimitNotice("No snapchat account for user 123 was found")).toBe(false);
  });
});
