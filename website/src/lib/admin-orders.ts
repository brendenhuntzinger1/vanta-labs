import { supabaseAdmin } from "@/lib/supabase-server";

export interface AdminOrderRow {
  id: string;
  order_id: string;
  customer_email: string | null;
  amount_paid: number;
  referral_code: string | null;
  payment_status: string;
  item_count: number;
}

export async function getAdminOrderRows(): Promise<AdminOrderRow[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, order_id, customer_email, amount_paid, referral_code, payment_status")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const orderIds = data.map((order) => order.id);
  const { data: itemData, error: itemError } = await supabaseAdmin
    .from("order_items")
    .select("order_id, quantity")
    .in("order_id", orderIds);

  if (itemError) {
    throw itemError;
  }

  const itemCounts = new Map<string, number>();
  for (const item of itemData ?? []) {
    const current = itemCounts.get(item.order_id) ?? 0;
    itemCounts.set(item.order_id, current + Number(item.quantity ?? 0));
  }

  return (data ?? []).map((order) => ({
    id: order.id,
    order_id: order.order_id,
    customer_email: order.customer_email,
    amount_paid: Number(order.amount_paid ?? 0),
    referral_code: order.referral_code,
    payment_status: order.payment_status,
    item_count: itemCounts.get(order.id) ?? 0,
  }));
}
