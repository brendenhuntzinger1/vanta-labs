// ---------------------------------------------------------------------------
// WHERE THE ADMIN CAN GO, AND WHICH TAB LIGHTS UP WHEN IT GETS THERE.
//
// Split out of admin-tabs.tsx so it carries no React import and can be asserted
// directly. admin-navigation.test.ts used to prove reachability by matching
// SOURCE TEXT — `expect(tabs).toContain('pathname.startsWith("/admin/...")')` —
// which passes or fails on how the predicate happens to be spelled rather than
// on where the tab goes. Refactoring the spelling broke a green test while the
// behaviour was identical.
//
// The property worth guarding is real, though, and the comment on that test
// says why: the Workstation shipped with nothing linking to it, so the only way
// to reach the screen that runs the day was to type the URL. A page nobody can
// navigate to has not shipped. With the config here, the test can assert the
// match functions themselves.
// ---------------------------------------------------------------------------

export type AdminTab = {
  label: string;
  href: string;
  match: (pathname: string) => boolean;
  /** Which live count, if any, belongs on this tab. */
  badge?: "work" | "critical";
};

export type AdminTabGroup = {
  /** The question this group answers. Kept to one or two words. */
  title: string;
  tabs: AdminTab[];
};

const startsWith = (prefix: string) => (pathname: string) => pathname.startsWith(prefix);

export const ADMIN_NAV_GROUPS: AdminTabGroup[] = [
  {
    title: "Today",
    tabs: [
      { label: "Live Sales & Visitors", href: "/admin", match: (p) => p === "/admin" },
      { label: "System Status", href: "/admin/status", match: startsWith("/admin/status"), badge: "critical" },
    ],
  },
  {
    title: "Fulfilment",
    tabs: [
      {
        // POINTS AT THE WORKSTATION, not /admin/fulfillment.
        //
        // The Workstation is the screen that runs the day — exceptions, then
        // batch, pick, pack. The older per-order list is still the place to
        // find ONE order by number, name, email or tracking, and the two link
        // to each other. The prefix match covers both so the tab stays lit on
        // either and neither feels like leaving.
        label: "Fulfillment",
        href: "/admin/fulfillment/workstation",
        match: startsWith("/admin/fulfillment"),
        badge: "work",
      },
      { label: "Orders", href: "/admin/orders", match: startsWith("/admin/orders") },
      { label: "Payments", href: "/admin/payments", match: startsWith("/admin/payments") },
      { label: "Customers", href: "/admin/customers", match: startsWith("/admin/customers") },
    ],
  },
  {
    title: "Catalogue",
    tabs: [
      { label: "Products", href: "/admin/products", match: startsWith("/admin/products") },
      { label: "Inventory", href: "/admin/inventory", match: startsWith("/admin/inventory") },
      { label: "COA Library", href: "/admin/coa", match: startsWith("/admin/coa") },
    ],
  },
  {
    title: "Money",
    tabs: [
      { label: "Revenue", href: "/admin/revenue", match: startsWith("/admin/revenue") },
      { label: "Reconciliation", href: "/admin/reconciliation", match: startsWith("/admin/reconciliation") },
    ],
  },
  {
    title: "Growth",
    tabs: [
      { label: "Ambassadors", href: "/admin/partners", match: startsWith("/admin/partners") },
      { label: "Coupons", href: "/admin/coupons", match: startsWith("/admin/coupons") },
      { label: "Promotions", href: "/admin/promotions", match: startsWith("/admin/promotions") },
      { label: "Membership", href: "/admin/membership", match: startsWith("/admin/membership") },
      { label: "Cart Recovery", href: "/admin/cart-recovery", match: startsWith("/admin/cart-recovery") },
      { label: "Email", href: "/admin/email", match: startsWith("/admin/email") },
      { label: "Advertising", href: "/admin/ads", match: startsWith("/admin/ads") },
    ],
  },
  {
    title: "Store setup",
    tabs: [
      // The Control Center editor lives at the bottom of the admin home page,
      // so nobody has to know to scroll "Live Sales & Visitors" to find site
      // configuration. It never matches: the dashboard tab owns /admin.
      { label: "Control Center", href: "/admin#control-editor", match: () => false },
      { label: "Settings", href: "/admin/settings", match: startsWith("/admin/settings") },
      { label: "Content", href: "/admin/content", match: startsWith("/admin/content") },
      { label: "Policies", href: "/admin/policies", match: startsWith("/admin/policies") },
    ],
  },
  {
    title: "Access",
    tabs: [
      { label: "Team", href: "/admin/team", match: startsWith("/admin/team") },
      { label: "Audit Log", href: "/admin/audit-log", match: startsWith("/admin/audit-log") },
      { label: "My Account", href: "/admin/account", match: startsWith("/admin/account") },
    ],
  },
];

/** Every tab, flattened — for lookups that do not care about grouping. */
export const ADMIN_TABS: AdminTab[] = ADMIN_NAV_GROUPS.flatMap((group) => group.tabs);

/** The tab that should be lit for a path, or undefined on an unknown route. */
export function activeAdminTab(pathname: string): AdminTab | undefined {
  return ADMIN_TABS.find((tab) => tab.match(pathname));
}
