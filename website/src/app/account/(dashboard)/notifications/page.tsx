import Link from "next/link";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerNotifications, type AccountNotification } from "@/lib/account-notifications";

export const dynamic = "force-dynamic";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Icon({ type }: { type: AccountNotification["icon"] }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "h-[18px] w-[18px]", "aria-hidden": true };
  switch (type) {
    case "shipping":
      return <svg {...common}><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" /><circle cx="7" cy="17" r="1.6" /><circle cx="18" cy="17" r="1.6" /></svg>;
    case "points":
      return <svg {...common}><path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.1 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
    case "billing":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>;
    case "alert":
      return <svg {...common}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></svg>;
    default:
      return <svg {...common}><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="m3.5 7.5 8.5 4.5 8.5-4.5" /></svg>;
  }
}

const TONE: Record<AccountNotification["tone"], string> = {
  success: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  info: "border-white/12 bg-white/[0.05] text-zinc-200",
};

export default async function AccountNotificationsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const notifications = await getCustomerNotifications(user.id, user.email).catch(() => []);

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Notifications</h1>
        <p className="mt-2 text-sm text-zinc-400">Order updates, rewards, and membership activity — all in one place.</p>
      </header>

      {notifications.length === 0 ? (
        <section className="vl-panel rounded-2xl p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/12 bg-white/[0.03] text-2xl">🔔</div>
          <h2 className="mt-5 text-lg font-semibold text-white">You&apos;re all caught up</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">Updates about your orders, points, and membership will show up here.</p>
        </section>
      ) : (
        <section className="vl-panel rounded-2xl p-3 sm:p-4">
          <ul className="divide-y divide-white/[0.06]">
            {notifications.map((n) => {
              const inner = (
                <div className="flex items-start gap-3.5 p-3">
                  <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${TONE[n.tone]}`}>
                    <Icon type={n.icon} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">{n.title}</p>
                    {n.body ? <p className="mt-0.5 text-xs text-zinc-500">{n.body}</p> : null}
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-500">{timeAgo(n.createdAt)}</span>
                </div>
              );
              return (
                <li key={n.id}>
                  {n.href ? (
                    <Link href={n.href} className="vl-focus-ring block rounded-xl transition-colors duration-200 hover:bg-white/[0.03]">{inner}</Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
