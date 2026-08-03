import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerOrders, getCustomerPreferences, getDefaultCustomerAddress, getWishlistSlugs } from "@/lib/customer-account";
import {
  checkAndAwardBirthdayBonus,
  getActivePointsMultiplier,
  getCustomerMembership,
  getMembershipPerks,
  getPointsBalance,
  getPointsHistory,
  getProgressToNextReward,
  pointsToDollars,
} from "@/lib/membership";
import { getActiveCouponsForDisplay } from "@/lib/coupons";
import { getLifetimeSavings } from "@/lib/member-savings";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { getBestSellerSlugs } from "@/lib/best-sellers";
import type { Product } from "@/lib/catalog-types";
import { ReorderButton } from "@/components/reorder-button";
import { AccountRecentlyViewed } from "@/components/account-recently-viewed";
import { FREE_SHIPPING_THRESHOLD } from "@/lib/shipping";
import { displayOrderReference } from "@/lib/order-reference";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
function shortOrderId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

const LEDGER_REASON_LABELS: Record<string, string> = {
  order_earn: "Order reward",
  order_refund_reversal: "Refund adjustment",
  redeem: "Redeemed at checkout",
  signup_bonus: "Welcome bonus",
  referral_bonus: "Referral bonus",
  birthday_bonus: "Birthday bonus",
  admin_adjustment: "Manual adjustment",
};

const UNPAID_STATUSES = ["pending", "pending_payment", "awaiting_verification", "unverified", "unpaid"];

function StatTile({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const inner = (
    <div className="vl-panel-soft h-full rounded-xl p-4 transition-colors duration-200 hover:border-white/20">
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="vl-focus-ring block rounded-xl">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function ProductMiniCard({ product }: { product: Product }) {
  return (
    <Link
      href={`/products/${product.slug}`}
      className="vl-focus-ring group w-40 shrink-0 snap-start rounded-xl border border-white/10 bg-white/[0.02] p-2.5 transition-colors duration-200 hover:border-white/25 sm:w-auto"
    >
      <div className="relative aspect-square overflow-hidden rounded-lg bg-white/5">
        <Image
          src={product.image || "/images/vantalabs.png"}
          alt={product.name}
          fill
          sizes="176px"
          className="object-cover transition-transform duration-300 group-hover:scale-105"
        />
      </div>
      <p className="mt-2.5 line-clamp-2 text-xs text-white/85">{product.name}</p>
      <p className="mt-1 text-xs text-white/50">${product.price}</p>
    </Link>
  );
}

export default async function AccountDashboardPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const preferences = await getCustomerPreferences(user.id);
  await checkAndAwardBirthdayBonus(user.id, preferences.birthday).catch(() => {});

  const [orders, membership, perks, pointsBalance, pointsHistory, activeCoupons, pointsMultiplier, lifetimeSavings, defaultAddress, wishlistSlugs, bestSellerSlugs] =
    await Promise.all([
      getCustomerOrders(user.id, user.email).catch(() => []),
      getCustomerMembership(user.id),
      getMembershipPerks(user.id),
      getPointsBalance(user.id).catch(() => 0),
      getPointsHistory(user.id, 5).catch(() => []),
      getActiveCouponsForDisplay().catch(() => []),
      getActivePointsMultiplier().catch(() => ({ multiplier: 1, eventName: null as string | null })),
      getLifetimeSavings(user.id),
      getDefaultCustomerAddress(user.id).catch(() => null),
      getWishlistSlugs(user.id).catch(() => [] as string[]),
      getBestSellerSlugs().catch(() => new Set<string>()),
    ]);

  const fullName = (user.user_metadata?.full_name as string | undefined)?.trim() || "";
  const firstName = fullName ? fullName.split(/\s+/)[0] : "there";
  const progress = getProgressToNextReward(pointsBalance);

  // Recommended (store-wide best sellers) and wishlist previews are hydrated
  // from the live catalog — real products, real images, never placeholders.
  const [wishlistProducts, bestSellerProducts] = await Promise.all([
    wishlistSlugs.length ? getCatalogProductsBySlugs(wishlistSlugs.slice(0, 6)).catch(() => [] as Product[]) : Promise.resolve([] as Product[]),
    bestSellerSlugs.size ? getCatalogProductsBySlugs(Array.from(bestSellerSlugs)).catch(() => [] as Product[]) : Promise.resolve([] as Product[]),
  ]);
  const recommended = bestSellerProducts.filter((p) => !wishlistSlugs.includes(p.slug)).slice(0, 4);

  const isActiveMember = perks.isActiveMember;
  // "Paid" means an ACTIVE paid plan. A row that exists but was never paid for
  // (or has lapsed) must not surface billing dates or a tier badge.
  const isPaid = membership.billingCycle !== "free" && isActiveMember;
  const pastDue = membership.status === "past_due";
  const recentOrders = orders.slice(0, 3);
  const lastOrder = orders[0];

  // Friendly account-status pill
  const status = pastDue
    ? { text: "Payment needed", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
    : isActiveMember
      ? { text: "Active member", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" }
      : membership.status === "cancelled"
        ? { text: "Membership ending", cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300" }
        : { text: "No active membership", cls: "border-white/15 bg-white/[0.04] text-zinc-300" };

  return (
    <div className="space-y-5">
      {/* Welcome hero */}
      <section className="vl-fade-up vl-panel overflow-hidden rounded-2xl p-5 sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Dashboard</p>
            <h1 className="vl2-serif mt-2 text-3xl text-white sm:text-4xl">Welcome back, {firstName}.</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${status.cls}`}>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                {status.text}
              </span>
              {isActiveMember && membership.tier.slug !== "free" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.06] px-3 py-1 text-xs text-[color:var(--accent-gold)]">
                  {membership.tier.name}
                </span>
              ) : null}
            </div>
          </div>

          <div className="shrink-0 sm:text-right">
            {isPaid ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                  {membership.cancelAtPeriodEnd ? "Access until" : "Next billing"}
                </p>
                <p className="mt-1 text-sm font-semibold text-white">
                  {membership.nextBillingAt ? new Date(membership.nextBillingAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                </p>
                <Link href="/account/subscriptions" className="mt-2 inline-block text-xs text-cyan-300 underline-offset-2 hover:underline">
                  Manage subscription →
                </Link>
              </div>
            ) : (
              <Link href="/membership" className="vl2-btn-primary vl-focus-ring inline-flex px-5 py-3 text-xs">
                Choose a membership
              </Link>
            )}
          </div>
        </div>

        {pastDue ? (
          <div className="mt-5 flex flex-col gap-3 rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-amber-100/90">
              Your membership payment didn&apos;t go through, so member benefits are paused until it&apos;s resolved.
            </p>
            <Link href="/account/subscriptions" className="vl-focus-ring shrink-0 rounded-full border border-amber-300/50 bg-amber-300/10 px-4 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/20">
              Resolve payment →
            </Link>
          </div>
        ) : null}

        {lifetimeSavings.total > 0 ? (
          <div className="mt-5 rounded-xl border border-amber-200/25 bg-gradient-to-r from-amber-200/[0.10] via-amber-200/[0.04] to-transparent p-4 sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-amber-200/70">Your savings with Vanta Labs</p>
            <p className="mt-1.5 text-3xl font-semibold text-amber-200">{money(lifetimeSavings.total)}</p>
            <p className="mt-1 text-xs text-zinc-400">
              across {lifetimeSavings.paidOrders} paid order{lifetimeSavings.paidOrders === 1 ? "" : "s"}
            </p>
          </div>
        ) : null}
      </section>

      {/* Stat tiles */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Point balance" value={pointsBalance.toLocaleString()} sub={`≈ ${money(pointsToDollars(pointsBalance))} in rewards`} href="/account/rewards" />
        <StatTile
          label="Earn rate"
          value={`${perks.pointsPerDollar}×`}
          sub={pointsMultiplier.multiplier > 1 ? `${pointsMultiplier.eventName} (${pointsMultiplier.multiplier}× active)` : "points per $1"}
        />
        {lifetimeSavings.total > 0 ? (
          <StatTile label="Lifetime saved" value={money(lifetimeSavings.total)} sub="member savings" />
        ) : (
          <StatTile label="Free shipping" value={`$${FREE_SHIPPING_THRESHOLD}+`} sub="on qualifying orders" />
        )}
        <StatTile label="Orders" value={orders.length.toLocaleString()} sub="all time" href="/account/orders" />
      </section>

      {/* Progress to next reward */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">Progress to your next reward</span>
          <span>{progress.pointsIntoMilestone} / {progress.milestone} pts</span>
        </div>
        <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-cyan-300 transition-[width] duration-500" style={{ width: `${progress.progressPercent}%` }} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Redeem points at checkout — 100 points = $1 off. <Link href="/account/rewards" className="text-cyan-300 underline-offset-2 hover:underline">See rewards →</Link>
        </p>
      </section>

      {/* Latest orders */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Latest orders</h2>
          {orders.length > 0 ? (
            <Link href="/account/orders" className="vl-focus-ring text-xs text-cyan-300 underline-offset-2 hover:underline">View all →</Link>
          ) : null}
        </div>

        {recentOrders.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-zinc-300">No orders yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-xs text-zinc-500">When you place your first order it&apos;ll appear here with tracking, invoices, and one-tap reorder.</p>
            <Link href="/products" className="vl2-btn-secondary vl-focus-ring mt-5 inline-flex px-5 py-2.5 text-xs">Browse products</Link>
          </div>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {recentOrders.map((order) => {
              const unpaid = UNPAID_STATUSES.includes(String(order.paymentStatus).toLowerCase());
              return (
                <li key={order.orderId}>
                  <Link
                    href={`/account/orders/${encodeURIComponent(order.orderId)}`}
                    className="vl-focus-ring flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5 transition-colors duration-200 hover:border-white/25"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">Order {displayOrderReference(order.orderNumber, order.orderId)}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {new Date(order.createdAt).toLocaleDateString()} · {order.items.length} item{order.items.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-white">{money(order.amountPaid)}</p>
                      <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] ${
                        unpaid ? "bg-amber-300/15 text-amber-200" : order.fulfillmentStatus === "delivered" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/8 text-zinc-300"
                      }`}>
                        {statusLabel(unpaid ? order.paymentStatus : order.fulfillmentStatus)}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {/* Quick reorder — most recent order, one tap back into the cart */}
        {lastOrder ? (
          <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white">Quick reorder</p>
              <p className="text-xs text-zinc-500">Add the items from your most recent order back to the cart.</p>
            </div>
            <ReorderButton orderId={lastOrder.orderId} />
          </div>
        ) : null}
      </section>

      {/* Recommended */}
      {recommended.length > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Popular right now</h2>
              <p className="mt-0.5 text-xs text-zinc-500">Best sellers across the Vanta Labs catalog.</p>
            </div>
            <Link href="/products" className="vl-focus-ring text-xs text-cyan-300 underline-offset-2 hover:underline">Shop all →</Link>
          </div>
          <div className="mt-4 flex snap-x gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-4 sm:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {recommended.map((product) => (
              <ProductMiniCard key={product.slug} product={product} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Wishlist preview */}
      {wishlistProducts.length > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Your wishlist</h2>
            <Link href="/account/wishlist" className="vl-focus-ring text-xs text-cyan-300 underline-offset-2 hover:underline">View all →</Link>
          </div>
          <div className="mt-4 flex snap-x gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-4 sm:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {wishlistProducts.slice(0, 4).map((product) => (
              <ProductMiniCard key={product.slug} product={product} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Recently viewed (client / localStorage) */}
      <AccountRecentlyViewed />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Recent activity */}
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Recent activity</h2>
            <Link href="/account/rewards" className="vl-focus-ring text-xs text-cyan-300 underline-offset-2 hover:underline">All →</Link>
          </div>
          {pointsHistory.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No activity yet — your rewards will show up here.</p>
          ) : (
            <ul className="mt-3 divide-y divide-white/10">
              {pointsHistory.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-zinc-200">{LEDGER_REASON_LABELS[entry.reason] ?? entry.reason}</p>
                    <p className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className={entry.amount >= 0 ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                    {entry.amount >= 0 ? "+" : ""}{entry.amount.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Default address + coupons */}
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Shipping address</h2>
            <Link href="/account/addresses" className="vl-focus-ring text-xs text-cyan-300 underline-offset-2 hover:underline">Manage →</Link>
          </div>
          {defaultAddress ? (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-300">
              <p className="font-medium text-white">{defaultAddress.fullName}</p>
              <p className="mt-1 text-zinc-400">{defaultAddress.address}</p>
              <p className="text-zinc-400">{defaultAddress.city}{defaultAddress.postalCode ? `, ${defaultAddress.postalCode}` : ""}</p>
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-5 text-center">
              <p className="text-sm text-zinc-400">No saved address yet</p>
              <Link href="/account/addresses" className="vl2-btn-secondary vl-focus-ring mt-4 inline-flex px-4 py-2 text-xs">Add address</Link>
            </div>
          )}

          {activeCoupons.length > 0 ? (
            <div className="mt-5 border-t border-white/10 pt-4">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Available coupons</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {activeCoupons.map((coupon) => (
                  <span key={coupon.code} className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-zinc-200">
                    <span className="font-mono font-semibold text-cyan-300">{coupon.code}</span>
                    {" — "}
                    {coupon.discountType === "fixed" ? money(coupon.discountValue) : `${coupon.discountValue}%`} off
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
