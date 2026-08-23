import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
