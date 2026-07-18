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
    <div className="min-h-screen bg-zinc-950 p-8 text-zinc-100">
      <div className="mx-auto max-w-5xl rounded-2xl border border-zinc-800 bg-zinc-900/70 p-8">
        <h1 className="text-3xl font-semibold">{data.order_id}</h1>
        <p className="mt-2 text-sm text-zinc-400">Customer: {data.customer_email}</p>
        <pre className="mt-6 overflow-x-auto rounded-xl bg-zinc-950 p-4 text-sm text-zinc-300">
{JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
