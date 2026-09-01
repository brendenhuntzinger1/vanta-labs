import { describe, expect, it } from "vitest";
import {
  AFFILIATE_FILTERS,
  isAffiliateFilter,
  ACTIVE_AFFILIATE_STATUSES,
  isActiveAffiliate,
  selectAffiliateRecipients,
  type AffiliateRow,
} from "@/lib/email/affiliate-audience";

const SITE = "https://vantalabsresearch.com";

function affiliate(overrides: Partial<AffiliateRow> = {}): AffiliateRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "jordan@example.com",
    first_name: "Jordan",
    referral_code: "JORDAN10",
    commission_percent: 15,
    status: "approved",
    disabled_at: null,
    ...overrides,
  };
}

function select(input: {
  rows: AffiliateRow[];
  suppressed?: string[];
  filter?: "all_active" | "selected";
  ambassadorIds?: string[];
}) {
  return selectAffiliateRecipients({
    rows: input.rows,
    suppressed: new Set(input.suppressed ?? []),
    filter: input.filter ?? "all_active",
    ambassadorIds: input.ambassadorIds ?? [],
    siteUrl: SITE,
  });
}

describe("who counts as an active affiliate", () => {
  it.each([...ACTIVE_AFFILIATE_STATUSES])("includes status %s", (status) => {
    expect(isActiveAffiliate({ status, disabled_at: null })).toBe(true);
  });

  it.each(["pending", "rejected", "disabled", "info_requested", "", null])("excludes status %s", (status) => {
    expect(isActiveAffiliate({ status: status as string | null, disabled_at: null })).toBe(false);
  });

  it("excludes an approved affiliate who has since been disabled", () => {
    // Status can lag; disabled_at is the act of switching someone off, and an
    // affiliate the owner removed must not receive the next flash-sale blast.
    expect(isActiveAffiliate({ status: "approved", disabled_at: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  it("is case-insensitive, because status is free text", () => {
    expect(isActiveAffiliate({ status: "Approved", disabled_at: null })).toBe(true);
  });
});

describe("send to all affiliates", () => {
  it("returns one recipient per active affiliate", () => {
    const recipients = select({
      rows: [
        affiliate({ id: "a", email: "a@example.com", referral_code: "AAA" }),
        affiliate({ id: "b", email: "b@example.com", referral_code: "BBB" }),
      ],
    });
    expect(recipients.map((r) => r.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("leaves out pending applicants", () => {
    const recipients = select({
      rows: [affiliate({ id: "a", email: "a@example.com" }), affiliate({ id: "b", email: "b@example.com", status: "pending" })],
    });
    expect(recipients.map((r) => r.email)).toEqual(["a@example.com"]);
  });

  it("skips an affiliate with no email address on file", () => {
    const recipients = select({ rows: [affiliate({ email: null }), affiliate({ id: "b", email: "b@example.com" })] });
    expect(recipients.map((r) => r.email)).toEqual(["b@example.com"]);
  });

  it("normalises addresses so casing cannot produce two sends", () => {
    const recipients = select({ rows: [affiliate({ email: "  Jordan@Example.COM " })] });
    expect(recipients[0].email).toBe("jordan@example.com");
  });
});

describe("suppression is subtracted here as well as at send time", () => {
  // Duplicated on purpose, exactly as the customer audience does it: the
  // per-send check is the guarantee, but subtracting up front is what makes
  // the count the owner sees before pressing Send the truth rather than an
  // overestimate that quietly shrinks.
  it("removes an affiliate who unsubscribed", () => {
    const recipients = select({
      rows: [affiliate({ id: "a", email: "a@example.com" }), affiliate({ id: "b", email: "b@example.com" })],
      suppressed: ["b@example.com"],
    });
    expect(recipients.map((r) => r.email)).toEqual(["a@example.com"]);
  });

  it("matches suppression case-insensitively", () => {
    const recipients = select({ rows: [affiliate({ email: "Jordan@Example.com" })], suppressed: ["jordan@example.com"] });
    expect(recipients).toEqual([]);
  });

  it("still removes a hand-picked affiliate who unsubscribed", () => {
    // Picking someone explicitly is not consent on their behalf.
    const recipients = select({
      rows: [affiliate({ id: "a", email: "a@example.com" })],
      suppressed: ["a@example.com"],
      filter: "selected",
      ambassadorIds: ["a"],
    });
    expect(recipients).toEqual([]);
  });
});

describe("one message per person", () => {
  it("collapses two affiliate rows sharing an address", () => {
    // partners/ambassadors are twinned identities and a person can be
    // pre-added and then apply. Two rows must never mean two copies.
    const recipients = select({
      rows: [
        affiliate({ id: "a", email: "same@example.com", referral_code: "FIRST" }),
        affiliate({ id: "b", email: "same@example.com", referral_code: "SECOND" }),
      ],
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].mergeContext.referralCode).toBe("FIRST");
  });
});

describe("hand-picking a subset", () => {
  const rows = [
    affiliate({ id: "a", email: "a@example.com" }),
    affiliate({ id: "b", email: "b@example.com" }),
    affiliate({ id: "c", email: "c@example.com" }),
  ];

  it("sends only to the chosen affiliates", () => {
    const recipients = select({ rows, filter: "selected", ambassadorIds: ["a", "c"] });
    expect(recipients.map((r) => r.email)).toEqual(["a@example.com", "c@example.com"]);
  });

  it("still refuses an inactive affiliate who was picked by hand", () => {
    const recipients = select({
      rows: [affiliate({ id: "a", email: "a@example.com", status: "pending" })],
      filter: "selected",
      ambassadorIds: ["a"],
    });
    expect(recipients).toEqual([]);
  });

  it("sends to nobody when nothing was picked, rather than falling back to everyone", () => {
    // The dangerous default. "selected" with an empty list must mean zero, not
    // the whole programme — that mistake is unrecallable.
    expect(select({ rows, filter: "selected", ambassadorIds: [] })).toEqual([]);
  });

  it("ignores an id that matches no affiliate", () => {
    const recipients = select({ rows, filter: "selected", ambassadorIds: ["a", "does-not-exist"] });
    expect(recipients.map((r) => r.email)).toEqual(["a@example.com"]);
  });
});

describe("the merge context each recipient carries", () => {
  it("is built from that affiliate's own record", () => {
    const [recipient] = select({
      rows: [affiliate({ id: "abc", email: "j@example.com", first_name: "Jordan", referral_code: "JORDAN10", commission_percent: 12.5 })],
    });
    expect(recipient.ambassadorId).toBe("abc");
    expect(recipient.mergeContext).toEqual({
      firstName: "Jordan",
      referralCode: "JORDAN10",
      referralLink: `${SITE}/r/JORDAN10`,
      commissionPercent: 12.5,
      dashboardLink: `${SITE}/account/ambassador`,
    });
  });

  it("builds the referral link in the same shape the portal shows", () => {
    const [recipient] = select({ rows: [affiliate({ referral_code: "ZAIN" })] });
    expect(recipient.mergeContext.referralLink).toBe(`${SITE}/r/ZAIN`);
  });

  it("survives a missing first name without failing the whole send", () => {
    const [recipient] = select({ rows: [affiliate({ first_name: null })] });
    expect(recipient.mergeContext.firstName).toBeNull();
  });

  it("carries a zero rate as zero rather than inventing one", () => {
    const [recipient] = select({ rows: [affiliate({ commission_percent: 0 })] });
    expect(recipient.mergeContext.commissionPercent).toBe(0);
  });
});

describe("sales-based groups", () => {
  const rows = [
    affiliate({ id: "quiet", email: "quiet@example.com" }),
    affiliate({ id: "seller", email: "seller@example.com" }),
  ];
  const qualifyingSales = new Map([["seller", 3]]);

  function group(filter: "no_sales" | "has_sales") {
    return selectAffiliateRecipients({
      rows,
      suppressed: new Set<string>(),
      filter,
      ambassadorIds: [],
      siteUrl: SITE,
      qualifyingSales,
    }).map((r) => r.email);
  }

  it("reaches only affiliates who have never had a qualifying sale", () => {
    expect(group("no_sales")).toEqual(["quiet@example.com"]);
  });

  it("reaches only affiliates who have made qualifying sales", () => {
    expect(group("has_sales")).toEqual(["seller@example.com"]);
  });

  it("treats an affiliate absent from the sales map as having none", () => {
    // An affiliate with no referral_orders rows at all has no map entry, and
    // that must read as zero rather than dropping them from both groups.
    const recipients = selectAffiliateRecipients({
      rows: [affiliate({ id: "brand-new", email: "new@example.com" })],
      suppressed: new Set<string>(),
      filter: "no_sales",
      ambassadorIds: [],
      siteUrl: SITE,
      qualifyingSales: new Map(),
    });
    expect(recipients.map((r) => r.email)).toEqual(["new@example.com"]);
  });

  it("still excludes suppressed and inactive affiliates inside a group", () => {
    const recipients = selectAffiliateRecipients({
      rows: [
        affiliate({ id: "quiet", email: "quiet@example.com" }),
        affiliate({ id: "pending", email: "pending@example.com", status: "pending" }),
      ],
      suppressed: new Set(["quiet@example.com"]),
      filter: "no_sales",
      ambassadorIds: [],
      siteUrl: SITE,
      qualifyingSales: new Map(),
    });
    expect(recipients).toEqual([]);
  });
});

describe("the filter allow-list", () => {
  it.each(["all_active", "selected", "no_sales", "has_sales"])("accepts %s", (value) => {
    expect(isAffiliateFilter(value)).toBe(true);
  });

  it.each(["everyone", "", "ALL_ACTIVE", null, undefined])("rejects %s", (value) => {
    expect(isAffiliateFilter(value)).toBe(false);
  });

  it("offers every valid filter in the composer list", () => {
    expect(AFFILIATE_FILTERS.map((f) => f.value).sort()).toEqual(["all_active", "has_sales", "no_sales", "selected"]);
  });
});
