"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/* ------------------------------------------------------------------ */
/*  Icons — inline 24×24 stroke-1.75 currentColor, matching the site.  */
/* ------------------------------------------------------------------ */

type IconProps = { className?: string };
const base = "h-[22px] w-[22px]";

function IconHome({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}
function IconOrders({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" />
      <path d="M3.5 7.5 12 12l8.5-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}
function IconSubscriptions({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}
function IconHeart({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 20s-7-4.4-9.2-8.6C1.2 8.1 2.7 5 5.8 5c1.9 0 3.2 1.1 4.2 2.4C11 6.1 12.3 5 14.2 5c3.1 0 4.6 3.1 3 6.4C19 15.6 12 20 12 20Z" />
    </svg>
  );
}
function IconRewards({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z" />
    </svg>
  );
}
function IconSupport({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M8.5 10h.01M12 10h.01M15.5 10h.01" />
    </svg>
  );
}
function IconSettings({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6" />
    </svg>
  );
}
function IconProducts({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function IconAmbassador({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8 4h8v4a4 4 0 0 1-8 0z" />
      <path d="M8 5H5v1.5A3.5 3.5 0 0 0 8 10M16 5h3v1.5A3.5 3.5 0 0 1 16 10" />
      <path d="M12 12v4M9 20h6M10 16h4" />
    </svg>
  );
}
function IconLogout({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M15 4h4v16h-4" />
      <path d="M10 8l-4 4 4 4M6 12h11" />
    </svg>
  );
}
function IconMore({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Nav config                                                        */
/* ------------------------------------------------------------------ */

type NavItem = {
  href: string;
  label: string;
  icon: (p: IconProps) => React.ReactElement;
  /** matches the active route (exact for /account, prefix for the rest) */
  exact?: boolean;
  external?: boolean;
};

const PRIMARY: NavItem[] = [
  { href: "/account", label: "Home", icon: IconHome, exact: true },
  { href: "/account/orders", label: "Orders", icon: IconOrders },
  { href: "/account/subscriptions", label: "Subscriptions", icon: IconSubscriptions },
  { href: "/account/wishlist", label: "Wishlist", icon: IconHeart },
  { href: "/account/rewards", label: "Rewards", icon: IconRewards },
];

const SECONDARY: NavItem[] = [
  { href: "/account/support", label: "Support", icon: IconSupport },
  { href: "/account/settings", label: "Settings", icon: IconSettings },
  { href: "/products", label: "Shop products", icon: IconProducts, external: true },
];

const AMBASSADOR_ITEM: NavItem = { href: "/account/ambassador", label: "Ambassador", icon: IconAmbassador };

function isActive(pathname: string, item: NavItem) {
  if (item.external) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/* ------------------------------------------------------------------ */
/*  Shared sign-out                                                    */
/* ------------------------------------------------------------------ */

function useSignOut() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    try {
      // Clear BOTH the server httpOnly session cookie AND the browser Supabase
      // session — otherwise the client silently re-establishes the session.
      await Promise.allSettled([
        fetch("/api/auth/session", { method: "DELETE" }),
        supabase.auth.signOut(),
      ]);
    } finally {
      router.push("/");
      router.refresh();
    }
  };
  return { signOut, signingOut };
}

/* ------------------------------------------------------------------ */
/*  Desktop sidebar                                                    */
/* ------------------------------------------------------------------ */

function SidebarLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`vl-focus-ring group flex min-h-[46px] items-center gap-3 rounded-xl px-3.5 text-sm transition-colors duration-200 ${
        active
          ? "border border-cyan-300/40 bg-cyan-400/15 font-semibold text-cyan-100"
          : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-white"
      }`}
    >
      <span className={active ? "text-cyan-200" : "text-zinc-500 transition-colors duration-200 group-hover:text-white"}>
        <item.icon className="h-5 w-5" />
      </span>
      {item.label}
    </Link>
  );
}

function DesktopSidebar({
  pathname,
  name,
  tierName,
  isAmbassador,
}: {
  pathname: string;
  name: string;
  tierName: string;
  isAmbassador: boolean;
}) {
  const { signOut, signingOut } = useSignOut();
  const initial = (name?.trim()?.[0] ?? "V").toUpperCase();

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-28 space-y-3">
        <div className="vl-panel rounded-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/15 bg-gradient-to-br from-white/15 to-white/[0.03] text-base font-semibold text-white">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{name || "Member"}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-amber-200/80">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />
                {tierName}
              </p>
            </div>
          </div>
        </div>

        <nav aria-label="Account" className="vl-panel rounded-2xl p-2">
          <div className="space-y-1">
            {PRIMARY.map((item) => (
              <SidebarLink key={item.href} item={item} pathname={pathname} />
            ))}
            {isAmbassador ? <SidebarLink item={AMBASSADOR_ITEM} pathname={pathname} /> : null}
          </div>
          <div className="my-2 h-px bg-white/10" />
          <div className="space-y-1">
            {SECONDARY.map((item) => (
              <SidebarLink key={item.href} item={item} pathname={pathname} />
            ))}
          </div>
          <div className="my-2 h-px bg-white/10" />
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="vl-focus-ring flex min-h-[46px] w-full items-center gap-3 rounded-xl px-3.5 text-sm text-zinc-400 transition-colors duration-200 hover:bg-white/[0.04] hover:text-white disabled:opacity-60"
          >
            <IconLogout className="h-5 w-5" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Mobile bottom nav + "More" sheet                                   */
/* ------------------------------------------------------------------ */

function BottomTab({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`vl-focus-ring flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-xl transition-colors duration-200 ${
        active ? "text-cyan-200" : "text-zinc-500"
      }`}
    >
      <item.icon className="h-[22px] w-[22px]" />
      <span className="text-[10px] font-medium tracking-wide">{item.label}</span>
    </Link>
  );
}

function MobileNav({
  pathname,
  name,
  tierName,
  isAmbassador,
}: {
  pathname: string;
  name: string;
  tierName: string;
  isAmbassador: boolean;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { signOut, signingOut } = useSignOut();

  // Close the sheet on route change + lock body scroll while open.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [sheetOpen]);

  const moreItems: NavItem[] = [
    { href: "/account/rewards", label: "Rewards", icon: IconRewards },
    ...(isAmbassador ? [AMBASSADOR_ITEM] : []),
    ...SECONDARY,
  ];
  const bottomItems = [PRIMARY[0], PRIMARY[1], PRIMARY[2], PRIMARY[3]];

  return (
    <>
      {/* Bottom tab bar — fixed, safe-area aware */}
      <nav
        aria-label="Account"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0b0b0b]/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto flex max-w-md items-stretch gap-1 py-1.5">
          {bottomItems.map((item) => (
            <BottomTab key={item.href} item={item} pathname={pathname} />
          ))}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            className="vl-focus-ring flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-zinc-500 transition-colors duration-200"
          >
            <IconMore className="h-[22px] w-[22px]" />
            <span className="text-[10px] font-medium tracking-wide">More</span>
          </button>
        </div>
      </nav>

      {/* More sheet */}
      {sheetOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="More account options">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/60 backdrop-blur-sm"
          />
          <div className="vl-sheet-in absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-white/10 bg-[#101014] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-20px_60px_rgba(0,0,0,0.6)]">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-white/20" />
            <div className="mb-3 flex items-center gap-3 rounded-2xl bg-white/[0.03] p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-gradient-to-br from-white/15 to-white/[0.03] text-sm font-semibold text-white">
                {(name?.trim()?.[0] ?? "V").toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{name || "Member"}</p>
                <p className="text-[11px] uppercase tracking-[0.16em] text-amber-200/80">{tierName}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {moreItems.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`vl-focus-ring flex min-h-[52px] items-center gap-3 rounded-xl px-4 text-sm transition-colors duration-200 ${
                      active ? "bg-cyan-400/15 font-semibold text-cyan-100" : "bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]"
                    }`}
                  >
                    <item.icon className="h-5 w-5" />
                    {item.label}
                  </Link>
                );
              })}
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className="vl-focus-ring flex min-h-[52px] items-center gap-3 rounded-xl bg-white/[0.03] px-4 text-sm text-zinc-200 transition-colors duration-200 hover:bg-white/[0.06] disabled:opacity-60"
              >
                <IconLogout className="h-5 w-5" />
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export function AccountDashboardNav({
  name,
  tierName,
  isAmbassador = false,
}: {
  name: string;
  tierName: string;
  isAmbassador?: boolean;
}) {
  const pathname = usePathname();
  return (
    <>
      <DesktopSidebar pathname={pathname} name={name} tierName={tierName} isAmbassador={isAmbassador} />
      <MobileNav pathname={pathname} name={name} tierName={tierName} isAmbassador={isAmbassador} />
    </>
  );
}
