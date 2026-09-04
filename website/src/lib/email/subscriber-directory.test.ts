import { describe, expect, it } from "vitest";
import { describeSubscriberSource, mergeSubscriberDirectory } from "@/lib/email/subscriber-directory";

// The list an owner reads has to agree with the list the sender uses: a person
// in email_suppressions must never show as subscribed, whatever the consent
// stores say, and a person who consented twice is one row, not two.

describe("mergeSubscriberDirectory", () => {
  it("shows one row per address with the earliest consent as its origin", () => {
    const out = mergeSubscriberDirectory({
      accounts: [{ email: "Sam@Example.com", createdAt: "2026-08-10T00:00:00Z" }],
      subscribers: [{ email: "sam@example.com", source: "checkout", optedInAt: "2026-08-01T00:00:00Z", unsubscribedAt: null }],
      suppressions: [],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ email: "sam@example.com", source: "checkout", since: "2026-08-01T00:00:00Z", status: "subscribed" });
    expect(out.counts.subscribed).toBe(1);
  });

  it("a suppression wins over consent, and says which message they left from", () => {
    const out = mergeSubscriberDirectory({
      accounts: [{ email: "gone@example.com", createdAt: "2026-08-10T00:00:00Z" }],
      subscribers: [],
      suppressions: [{ email: "gone@example.com", reason: "unsubscribed", source: "automation:winback_60", createdAt: "2026-09-01T00:00:00Z" }],
    });
    expect(out.rows[0]).toMatchObject({ status: "unsubscribed", unsubscribedFrom: "automation:winback_60", leftAt: "2026-09-01T00:00:00Z", since: "2026-08-10T00:00:00Z" });
    expect(out.counts).toEqual({ subscribed: 0, unsubscribed: 1, bounced: 0, complained: 0 });
  });

  it("maps provider reasons to bounced and complained, and lists suppression-only addresses", () => {
    const out = mergeSubscriberDirectory({
      accounts: [],
      subscribers: [],
      suppressions: [
        { email: "dead@example.com", reason: "bounced", source: null, createdAt: "2026-08-20T00:00:00Z" },
        { email: "soft@example.com", reason: "soft_bounce_run", source: null, createdAt: "2026-08-21T00:00:00Z" },
        { email: "angry@example.com", reason: "complained", source: null, createdAt: "2026-08-22T00:00:00Z" },
      ],
    });
    expect(out.rows.map((r) => [r.email, r.status])).toEqual([
      ["angry@example.com", "complained"],
      ["soft@example.com", "bounced"],
      ["dead@example.com", "bounced"],
    ]);
  });

  it("honours a guest row's own unsubscribed_at", () => {
    const out = mergeSubscriberDirectory({
      accounts: [],
      subscribers: [{ email: "left@example.com", source: "checkout", optedInAt: "2026-08-01T00:00:00Z", unsubscribedAt: "2026-08-15T00:00:00Z" }],
      suppressions: [],
    });
    expect(out.rows[0].status).toBe("unsubscribed");
  });

  it("sorts newest relationship first", () => {
    const out = mergeSubscriberDirectory({
      accounts: [{ email: "old@example.com", createdAt: "2026-07-01T00:00:00Z" }, { email: "new@example.com", createdAt: "2026-09-01T00:00:00Z" }],
      subscribers: [],
      suppressions: [],
    });
    expect(out.rows.map((r) => r.email)).toEqual(["new@example.com", "old@example.com"]);
  });

  it("names a cart-recovery-only address rather than calling it unknown", () => {
    const out = mergeSubscriberDirectory({
      accounts: [],
      subscribers: [],
      suppressions: [{ email: "cart@example.com", reason: "unsubscribed", source: "cart_recovery_t72h", createdAt: "2026-09-04T00:00:00Z" }],
    });
    expect(out.rows[0].source).toBe("cart_recovery");
    expect(describeSubscriberSource(out.rows[0].source)).toBe("Cart recovery only");
  });

  it("labels sources for a person, not a database", () => {
    expect(describeSubscriberSource("checkout")).toBe("Checkout opt-in");
    expect(describeSubscriberSource("signup")).toBe("Signup opt-in");
    expect(describeSubscriberSource("account")).toBe("Account preference");
    expect(describeSubscriberSource("")).toBe("Unknown");
  });
});
