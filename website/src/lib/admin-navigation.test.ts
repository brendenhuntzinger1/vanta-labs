import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUCKETS, EXCEPTION_REASONS } from "@/lib/fulfillment-buckets";

// ---------------------------------------------------------------------------
// A PAGE NOBODY CAN NAVIGATE TO HAS NOT SHIPPED.
//
// The Workstation — the whole point of the fulfillment work, the screen that
// runs the day — went live with NO link to it from anywhere in the
// application. The Fulfillment tab pointed at the older per-order list, so
// clicking Fulfillment landed on the page that existed before, and the only
// way to reach the new one was to type the URL. The owner's report was exactly
// what you would expect: "fulfillment screen looks the same".
//
// Every test passed the whole time. They tested what the page RENDERS. None of
// them could see that nothing pointed at it, because reachability is a property
// of the OTHER files.
//
// So it is asserted here, on the navigation itself.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Every file under a directory, recursively, as repo-relative posix paths. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(resolve(process.cwd(), rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk(dir);
  return out;
}

/** Source with comments removed, so an assertion reads what renders. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const WORKSTATION = "/admin/fulfillment/workstation";

describe("the fulfillment Workstation is reachable", () => {
  const tabs = source("src/components/admin-tabs.tsx");

  it("is where the Fulfillment tab actually goes", () => {
    expect(tabs).toContain(`href: "${WORKSTATION}"`);
  });

  it("keeps the tab lit on the search page too, so neither feels like leaving", () => {
    // Both live under /admin/fulfillment, so one prefix match covers the pair.
    expect(tabs).toContain('pathname.startsWith("/admin/fulfillment")');
  });

  it("is linked from the order-search page", () => {
    expect(source("src/app/admin/fulfillment/page.tsx")).toContain(`href="${WORKSTATION}"`);
  });

  it("links back to order search, so it is not a dead end", () => {
    // The board is organised by what needs DOING. When a customer emails about
    // one specific order the question is "where is order 1043", and that answer
    // lives in search — one click away, not a typed URL.
    expect(source("src/app/admin/fulfillment/workstation/page.tsx")).toContain('href="/admin/fulfillment"');
  });
});

// ---------------------------------------------------------------------------
// THE GENERAL RULE, so the next admin page cannot repeat this.
//
// Every route under /admin is either in the tab bar or linked from a page that
// is. A new page added with neither is unreachable, and this test says so by
// name rather than leaving it to be discovered in production.
// ---------------------------------------------------------------------------
describe("no admin page is orphaned", () => {
  // Routes deliberately reached another way. Each needs a reason, not just an
  // entry — an exception list nobody has to justify becomes a place to hide.
  const REACHED_ANOTHER_WAY: Record<string, string> = {
    "/admin": "the admin root; the tab bar lives on it",
    "/admin/orders/[orderId]": "opened from a row in the orders list",
    "/admin/fulfillment": "linked from the Workstation, and from Payments and Revenue",
  };

  it("every admin route is in the tab bar or linked from something that is", () => {
    const routeOf = (file: string) =>
      "/" + file
        .replace(/^src\/app\//, "")
        .replace(/\/page\.tsx$/, "")
        .replace(/\/\([^)]+\)/g, "");

    const pages = filesUnder("src/app/admin").filter((f) => f.endsWith("/page.tsx"));
    const routes = pages.map(routeOf);

    // EVERY admin page AND every component, not just the pages.
    //
    // The first run of this test reported /admin/partners/[partnerId] as an
    // orphan. It is not — the partner name in the table links to it — but the
    // link lives in admin-partners-client.tsx, and only page.tsx files were
    // being read. That was a defect in this test, not in the application, and
    // the fix is to widen what counts as a link rather than to add an
    // exception. An exception would have hidden the next real orphan.
    const corpus = [...pages, ...filesUnder("src/components").filter((f) => f.endsWith(".tsx"))]
      .map(source)
      .join("\n");

    const tabs = source("src/components/admin-tabs.tsx");

    const orphans = routes.filter((route) => {
      if (route in REACHED_ANOTHER_WAY) return false;
      if (tabs.includes(`"${route}"`)) return false;
      // A dynamic route is linked by its STATIC PREFIX plus an interpolated id
      // (`/admin/partners/${row.id}`), so the literal route string never
      // appears. Match the prefix instead.
      const dynamic = route.indexOf("/[");
      if (dynamic !== -1) return !corpus.includes(route.slice(0, dynamic + 1));
      return !corpus.includes(`"${route}"`);
    });

    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SAME DEFECT, ON THE CUSTOMER SIDE.
//
// /partner/pending exists to tell an applicant where their application stands
// — it has written copy for pending, info_requested, rejected and disabled,
// and a working endpoint behind it. Nothing in the application routed to it.
//
// So an ambassador who applied and was waiting got the same silent bounce as a
// stranger: sign in, look for the ambassador area, land back on the account
// page with no explanation. Including the applicant we had explicitly asked
// for more information, who had no way to learn we were waiting on them.
//
// The two "no" answers must stay different. Someone who never applied still
// gets nothing — telling them anything would leak that the programme has
// states at all.
// ---------------------------------------------------------------------------
describe("an ambassador applicant is told where they stand", () => {
  const page = source("src/app/account/(dashboard)/ambassador/page.tsx");

  it("sends an applicant who is not yet approved to the status page", () => {
    expect(page).toContain("/partner/pending");
  });

  it("still sends someone with no application at all back to their account", () => {
    // The distinction is the whole point: one is information the applicant is
    // owed, the other would tell a stranger the programme exists.
    expect(page).toMatch(/application \? "\/partner\/pending" : "\/account"/);
  });

  it("looks up the application without the approved-only filter", () => {
    // getApprovedPartnerByAuthUserId returns null for a pending applicant, so
    // it cannot tell "waiting" apart from "never applied".
    expect(page).toContain("getPartnerByAuthUserId");
  });

  it("keeps the status page's own data source intact", () => {
    // A page routed to but fed by a missing endpoint is the same defect wearing
    // a different hat.
    expect(source("src/app/partner/pending/page.tsx")).toContain("/api/partner/me");
    expect(() => source("src/app/api/partner/me/route.ts")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A CONTROL MUST NOT PROMISE WHAT THE DESTINATION CANNOT DO.
//
// Two of these were live at once, both on the money path, and both are the
// same shape as the Workstation: the system moved on and the interface did not.
//
//   The membership signup page rendered a notice reading "Card collection
//   isn't connected yet — Vanta Labs hasn't finished setting up a payment
//   processor... contact support if you'd like your membership activated
//   manually." That was written before the Veyra lane existed. Card entry is
//   connected, and /api/membership/subscribe REFUSES to sell without a real
//   token — so the page was telling shoppers the store could not take their
//   card at the exact moment they were trying to pay.
//
//   The past-due panel offered "Update payment method" pointing at
//   /membership, the plans page, which cannot edit a stored card. There is no
//   card-replacement screen at all: /api/membership/update-payment-method has
//   never had a caller. A member whose card expired, actively trying to pay,
//   followed a button that did not do what it said.
// ---------------------------------------------------------------------------
describe("payment controls say what actually happens", () => {
  it("no longer tells shoppers the store cannot take a card", () => {
    // COMMENTS STRIPPED FIRST. The fix left a comment quoting the removed
    // sentence so the next reader knows why it went; matching raw source would
    // fail on that explanation rather than on anything a customer can see.
    // What must not come back is the RENDERED claim.
    const subscribe = stripComments(source("src/components/membership-subscribe-client.tsx"));
    // Matched on the claim, not the component name, so re-adding the sentence
    // anywhere on this page fails even under a different wrapper.
    expect(subscribe).not.toMatch(/isn&apos;t connected yet|hasn't finished setting up a payment/);
    expect(subscribe).not.toMatch(/activated manually/);
  });

  it("keeps the real card lane wired, so the notice was not hiding a gap", () => {
    const subscribe = source("src/components/membership-subscribe-client.tsx");
    expect(subscribe).toContain("/api/membership/card-config");
    expect(subscribe).toContain("setCardConfig");
  });

  it("does not offer to update a payment method when nothing can", () => {
    const subs = source("src/app/account/(dashboard)/subscriptions/page.tsx");
    expect(subs).not.toContain('cta: "Update payment method"');
  });

  it("still gives a lapsed member a route back to paying", () => {
    // The fix was to stop the button lying, NOT to remove the member's way
    // back. /membership genuinely restores a past-due membership, because
    // startMembershipSignup short-circuits only for active/trialing.
    const subs = source("src/app/account/(dashboard)/subscriptions/page.tsx");
    expect(subs).toContain('cta: "Restart membership"');
    expect(subs).toContain('href="/membership"');
  });
});

// ---------------------------------------------------------------------------
// THE OWNER GUIDE DESCRIBES THE SOFTWARE THAT EXISTS.
//
// A hand-maintained guide documents the version it was written against, and
// that is the version that stops being true first. So the queue list, the
// exception list and both staleness numbers are RENDERED FROM THE SAME
// CONSTANTS the Workstation itself uses — passed down as props, because
// fulfillment-buckets.ts is server-only and correctly so.
//
// These assertions hold that wiring. What they cannot check is the prose, which
// is the part code cannot know.
// ---------------------------------------------------------------------------
describe("the Owner Guide is generated from the real definitions", () => {
  const guide = source("src/components/fulfillment-owner-guide.tsx");
  const page = source("src/app/admin/fulfillment/workstation/page.tsx");

  it("is on the Workstation, where the work happens", () => {
    expect(page).toContain("FulfillmentOwnerGuide");
  });

  it("is fed the real buckets, exceptions and thresholds", () => {
    expect(page).toContain("buckets={BUCKETS");
    expect(page).toContain("exceptions={EXCEPTION_REASONS");
    expect(page).toContain("carrierStaleHours={CARRIER_ACCEPTANCE_STALE_HOURS}");
    expect(page).toContain("transitStaleDays={TRANSIT_STALE_DAYS}");
  });

  it("does not keep its own copy of the queue or exception lists", () => {
    // The failure this prevents: someone adds a queue, the board shows it, and
    // the guide silently keeps describing the old set.
    const body = stripComments(guide);
    expect(body).toContain("buckets.map(");
    expect(body).toContain("exceptions.map(");
    // Naming a queue in a sentence is fine — the flow narrative does it. What
    // must not appear is a second copy of the DEFINITIONS: the descriptions and
    // the exception guidance both live in fulfillment-buckets.ts, and a copy
    // here is what silently goes stale when a queue is added or reworded.
    const definitions = [
      ...BUCKETS.map((b) => b.description),
      ...EXCEPTION_REASONS.map((e) => e.action),
    ];
    for (const text of definitions) {
      expect(body).not.toContain(text);
    }
  });

  it("never quotes a staleness threshold as a literal number", () => {
    const body = stripComments(guide);
    expect(body).toContain("{carrierStaleHours}");
    expect(body).toContain("{transitStaleDays}");
    expect(body).not.toMatch(/36 hours/);
    expect(body).not.toMatch(/10 days/);
  });

  it("speaks the owner's language, not the database's", () => {
    // The guide is for the person packing boxes. A column name in it is a
    // defect: it means the explanation leaked implementation.
    const body = stripComments(guide);
    for (const jargon of [
      "fulfillment_status",
      "payment_status",
      "shippo_sync_status",
      "label_purchase_claimed_at",
      "order_items",
      "unit_cost_cents",
      "SELECT",
    ]) {
      expect(body).not.toContain(jargon);
    }
  });

  it("does not let the owner think a recorded refund moved money", () => {
    // The single most expensive misunderstanding available in this admin.
    expect(guide).toMatch(/does not send money back/i);
  });

  it("says plainly that reprinting does not buy postage", () => {
    expect(guide).toMatch(/[Rr]eprinting never buys new postage/);
  });

  it("marks the processing fee as an estimate, because it always is", () => {
    expect(guide).toMatch(/processor fee is an estimate/i);
  });
});
