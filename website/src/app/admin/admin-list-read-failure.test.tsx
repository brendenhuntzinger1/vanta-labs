import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// ADM-06 — A FAILED READ IS NOT AN EMPTY QUEUE.
//
// The money-facing admin lists loaded their rows as `.catch(() => empty page)`,
// so a database that did not answer rendered "0 manual payments", "No orders
// match these filters" and "$0.00 owed" — every one of them what a quiet store
// looks like, and every one of them what an outage looks like. The pages now
// carry the failure (settleRead) and say so, and never render the "0 results"
// copy over a read that did not happen.
//
// These tests drive the REAL page components with the readers made to fail.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getManualPaymentRows: vi.fn(),
  getAdminOrderRows: vi.fn(),
  getPayoutQueue: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirected"); } }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromCookie: async () => ({ username: "owner", role: "super_admin" }),
}));

// Payments page collaborators.
vi.mock("@/lib/admin-payments", () => ({ getManualPaymentRows: mocks.getManualPaymentRows }));
vi.mock("@/lib/admin-control", () => ({
  getPaymentMethodsConfig: async () => [],
  getReferralProgramConfig: async () => ({ enabled: true }),
}));
vi.mock("@/lib/payment-methods", () => ({
  getEnabledPaymentMethods: () => [],
  isManualPaymentMethod: () => false,
}));
vi.mock("@/components/admin-payments-client", () => ({
  AdminPaymentsClient: ({ rows }: { rows: unknown[] }) => (
    <p data-testid="payments-client">{rows.length === 0 ? "No manual payments match these filters yet." : `${rows.length} rows`}</p>
  ),
}));

// Orders page collaborators.
vi.mock("@/lib/admin-orders", () => ({ getAdminOrderRows: mocks.getAdminOrderRows }));
vi.mock("@/components/admin-orders-client", () => ({
  AdminOrdersClient: ({ orders }: { orders: unknown[] }) => (
    <p data-testid="orders-client">{orders.length === 0 ? "No orders match these filters." : `${orders.length} rows`}</p>
  ),
}));

// Partners page collaborators.
vi.mock("@/lib/partner-portal", () => ({
  getAdminPartnerRows: async () => [],
  getAdminOperationsSummary: async () => ({
    liveSalesToday: 0, liveSalesMonth: 0, newCustomers: 0, returningCustomers: 0, returningCustomerRate: 0,
    lowStockItems: 0, pendingShipments: 0, activeCoupons: 0, pendingNotifications: 0,
  }),
  getPayoutQueue: mocks.getPayoutQueue,
}));
vi.mock("@/lib/ambassador-commission", () => ({ listCommissionTierRules: async () => [] }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorMarketingResources: async () => [],
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 100, minimumPayoutThreshold: 50, commissionHoldDays: 30,
    stored: { minimumQualifyingOrder: true, minimumPayoutThreshold: true, commissionHoldDays: true },
  }),
}));
vi.mock("@/lib/admin-ambassadors", () => ({
  getFraudReviewRows: async () => [],
  getPayoutHistory: async () => [],
}));
vi.mock("@/components/admin-partners-client", () => ({ AdminPartnersClient: () => null }));

const EMPTY_PAGE = { rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 };
const searchParams = Promise.resolve({});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/admin/payments", () => {
  it("renders the queue normally when the read answers", async () => {
    mocks.getManualPaymentRows.mockResolvedValue(EMPTY_PAGE);
    const { default: Page } = await import("./payments/page");
    const html = renderToStaticMarkup(await Page({ searchParams }));

    expect(html).toContain("0 manual payments");
    expect(html).toContain("No manual payments match these filters yet.");
    expect(html).not.toContain("could not be loaded");
  });

  it("shows a read-failure notice and NO '0 results' claim when the read fails", async () => {
    mocks.getManualPaymentRows.mockRejectedValue(new Error("connection refused"));
    const { default: Page } = await import("./payments/page");
    const html = renderToStaticMarkup(await Page({ searchParams }));

    expect(html).toContain("Some figures on this page could not be loaded");
    expect(html).toContain("Did not load: Manual payments");
    expect(html).toContain("— manual payments (could not be loaded)");
    expect(html).not.toContain("0 manual payments");
    expect(html).not.toContain("No manual payments match these filters yet.");
    // The page itself still renders — the filters are still usable.
    expect(html).toContain("Payment Verification");
  });
});

describe("/admin/orders", () => {
  it("shows a read-failure notice and NO '0 results' claim when the read fails", async () => {
    mocks.getAdminOrderRows.mockRejectedValue(new Error("statement timeout"));
    const { default: Page } = await import("./orders/page");
    const html = renderToStaticMarkup(await Page({ searchParams }));

    expect(html).toContain("Did not load: Orders");
    expect(html).toContain("— active orders (could not be loaded)");
    expect(html).not.toContain("0 active order");
    expect(html).not.toContain("No orders match these filters.");
    expect(html).toContain("Admin Orders");
  });

  it("still says 0 when the read genuinely returns nothing", async () => {
    mocks.getAdminOrderRows.mockResolvedValue(EMPTY_PAGE);
    const { default: Page } = await import("./orders/page");
    const html = renderToStaticMarkup(await Page({ searchParams }));

    expect(html).toContain("0 active orders");
    expect(html).not.toContain("could not be loaded");
  });
});

describe("/admin/partners payout queue", () => {
  it("never claims '$0.00 owed' or an empty queue when the payout read fails", async () => {
    mocks.getPayoutQueue.mockRejectedValue(new Error("connection refused"));
    const { default: Page } = await import("./partners/page");
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain("Did not load: Payout queue");
    expect(html).toContain("— owed (could not be loaded)");
    expect(html).not.toContain("$0.00 owed");
    expect(html).not.toContain("No commissions have cleared the hold period yet");
  });

  it("renders the empty-queue copy only when the read answered", async () => {
    mocks.getPayoutQueue.mockResolvedValue({ rows: [], readyCount: 0, totalOwed: 0, minimumPayoutThreshold: 50 });
    const { default: Page } = await import("./partners/page");
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain("$0.00 owed");
    expect(html).toContain("No commissions have cleared the hold period yet");
    expect(html).not.toContain("could not be loaded");
  });
});
