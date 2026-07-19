import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const supabase = createServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    notFound();
  }

  const { data, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error || !data) {
    notFound();
  }

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="vl-panel mx-auto max-w-5xl rounded-2xl p-4 sm:p-8">
        <h1 className="break-all text-2xl font-semibold sm:text-3xl">{data.order_id}</h1>
        <p className="mt-2 text-sm text-zinc-400">Customer: {data.customer_email}</p>
        <pre className="mt-6 overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-300 sm:p-4 sm:text-sm">
{JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
