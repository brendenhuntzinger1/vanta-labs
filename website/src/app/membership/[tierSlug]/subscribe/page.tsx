import { redirect, notFound } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getTierBySlug } from "@/lib/membership";
import { MembershipSubscribeClient } from "@/components/membership-subscribe-client";

export const dynamic = "force-dynamic";

export default async function MembershipSubscribePage({
  params,
}: {
  params: Promise<{ tierSlug: string }>;
}) {
  const { tierSlug } = await params;
  const tier = await getTierBySlug(tierSlug);

  if (!tier || tier.slug === "free" || !tier.isActive) {
    notFound();
  }

  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect(`/account/login?redirect=${encodeURIComponent(`/membership/${tierSlug}/subscribe`)}`);
  }

  return <MembershipSubscribeClient tier={tier} />;
}
