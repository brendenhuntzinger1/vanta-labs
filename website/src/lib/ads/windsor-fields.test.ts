import { describe, expect, it } from "vitest";
import { COMMON_FIELDS, FIELDS, WINDSOR_CONNECTORS, fieldsFor } from "./windsor-client";

/**
 * THE FIELD MAP IS PINNED HERE, EXACTLY.
 *
 * Windsor does not reject an unknown field name — it omits the column. So a
 * typo does not fail: it produces rows that parse cleanly with that value
 * silently null, forever, while the ingest reports success and the dashboard
 * reports itself healthy. The first version of this map shipped with four wrong
 * names and nothing anywhere would have noticed.
 *
 * Every id below was read back from the live connector's own field list. This
 * file exists so that changing one requires deliberately changing the expected
 * value here too, rather than a rename sliding through under a green suite.
 *
 * TO RE-VERIFY (or to add a field), ask Windsor for the connector's field list
 * and confirm the id comes back before touching either file. An id that is not
 * returned does not exist, whatever the docs or a sensible guess suggest.
 */
const VERIFIED = {
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
    conversionValue: "total_complete_payment_rate",
  },
  reddit: {
    adgroupId: "ad_group_id",
    adgroupName: "ad_group_name",
    destinationUrl: "ad_click_url",
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
} as const;

describe("the Windsor field map matches what the live API actually exposes", () => {
  it("pins every connector exactly", () => {
    expect(FIELDS).toEqual(VERIFIED);
  });

  it("covers all four platforms and nothing else", () => {
    expect(Object.keys(FIELDS).sort()).toEqual(["facebook", "reddit", "snapchat", "tiktok"]);
    expect([...WINDSOR_CONNECTORS].sort()).toEqual(["facebook", "reddit", "snapchat", "tiktok"]);
  });

  // These four were WRONG in the first shipped version. Each would have left a
  // column permanently null with no error anywhere, so they get named
  // individually rather than only being covered by the deep-equal above.
  it("uses ad_group_id on TikTok and Reddit, not adgroup_id", () => {
    expect(FIELDS.tiktok.adgroupId).toBe("ad_group_id");
    expect(FIELDS.reddit.adgroupId).toBe("ad_group_id");
    expect(FIELDS.tiktok.adgroupId).not.toBe("adgroup_id");
    expect(FIELDS.reddit.adgroupId).not.toBe("adgroup_id");
  });

  it("uses ad_squad_id on Snapchat, not adsquad_id", () => {
    expect(FIELDS.snapchat.adgroupId).toBe("ad_squad_id");
    expect(FIELDS.snapchat.adgroupName).toBe("ad_squad_name");
  });

  it("knows Reddit DOES expose a landing URL", () => {
    // Believing otherwise means believing Reddit ads can never be auto-attributed
    // to a creative, which would send the owner off to hand-name every ad.
    expect(FIELDS.reddit.destinationUrl).toBe("ad_click_url");
  });

  it("knows Snapchat exposes none", () => {
    // A fact about the platform, not a gap to paper over. The dashboard explains
    // this blind spot rather than silently showing a smaller number.
    expect(FIELDS.snapchat.destinationUrl).toBeNull();
  });

  it("counts only click-attributed purchases on Reddit", () => {
    // conversion_purchase_views is the other half. Counting both would credit an
    // impression nobody clicked.
    expect(FIELDS.reddit.conversions).toBe("conversion_purchase_clicks");
  });
});

describe("no guessed aliases or fallback chains", () => {
  // A fallback that tries three names and takes whichever answers is the same
  // silent failure wearing a seatbelt: it hides which name was right, so the map
  // can rot without anything failing.
  it("gives exactly one name per field", () => {
    for (const connector of WINDSOR_CONNECTORS) {
      const map = FIELDS[connector];
      for (const [key, value] of Object.entries(map)) {
        expect(typeof value === "string" || value === null, `${connector}.${key}`).toBe(true);
        if (typeof value === "string") {
          expect(value, `${connector}.${key} must not be a comma list`).not.toContain(",");
          expect(value, `${connector}.${key} must not be a pipe list`).not.toContain("|");
          expect(value.trim(), `${connector}.${key} must be non-empty`).not.toBe("");
        }
      }
    }
  });

  it("requests no duplicate fields, which Windsor would silently collapse", () => {
    for (const connector of WINDSOR_CONNECTORS) {
      const fields = fieldsFor(connector);
      expect(new Set(fields).size, `${connector} has duplicate fields`).toBe(fields.length);
    }
  });
});

describe("the request built from the map", () => {
  it("always asks for the eight fields common to all four connectors", () => {
    for (const connector of WINDSOR_CONNECTORS) {
      for (const field of COMMON_FIELDS) {
        expect(fieldsFor(connector), `${connector} missing ${field}`).toContain(field);
      }
    }
  });

  it("asks each connector for its own ad-group and conversion fields", () => {
    expect(fieldsFor("facebook")).toEqual(
      expect.arrayContaining(["adset_id", "adset_name", "link_url", "actions_purchase", "action_values_purchase"]),
    );
    expect(fieldsFor("tiktok")).toEqual(
      expect.arrayContaining(["ad_group_id", "ad_group_name", "landing_page_url", "complete_payment"]),
    );
    expect(fieldsFor("reddit")).toEqual(
      expect.arrayContaining(["ad_group_id", "ad_group_name", "ad_click_url", "conversion_purchase_clicks"]),
    );
    expect(fieldsFor("snapchat")).toEqual(
      expect.arrayContaining(["ad_squad_id", "ad_squad_name", "conversion_purchases"]),
    );
  });

  it("asks Snapchat for no URL field at all", () => {
    expect(fieldsFor("snapchat").some((f) => f.includes("url"))).toBe(false);
  });

  it("never asks another connector for a field that belongs to a different one", () => {
    // The cross-contamination that produced the original bugs: Meta's names
    // being assumed to hold everywhere.
    expect(fieldsFor("tiktok")).not.toContain("adset_id");
    expect(fieldsFor("reddit")).not.toContain("link_url");
    expect(fieldsFor("snapchat")).not.toContain("landing_page_url");
    expect(fieldsFor("facebook")).not.toContain("ad_group_id");
  });
});
