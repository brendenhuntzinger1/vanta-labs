import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getAllArticles } from "@/lib/articles";
import { AdminContentClient } from "@/components/admin-content-client";

export const dynamic = "force-dynamic";

export default async function AdminContentPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) redirect("/vault");
  if (!canManageSettings(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="vl-panel mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm text-zinc-400">
          Your role does not have permission to edit content.
        </div>
      </div>
    );
  }

  const articles = await getAllArticles();

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Content &amp; SEO</h1>
        <p className="mt-2 text-sm text-zinc-400">Edit the Research Library articles that draw organic traffic and reinforce your research-use-only positioning. Changes go live immediately.</p>
        <AdminContentClient articles={articles} />
      </div>
    </div>
  );
}
