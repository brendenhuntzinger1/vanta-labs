import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";

export interface CustomerOrderRow {
  orderId: string;
  amountPaid: number;
  paymentStatus: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  createdAt: string;
  items: Array<{ productId: string; productName: string; quantity: number; lineTotal: number; unitPrice: number }>;
}

// Server components run with the service-role client, so this is scoped
// explicitly by the caller-supplied email rather than relying solely on the
// customer_accounts.sql RLS policy (that policy exists for any future
// client-side/anon-key access path).
export async function getCustomerOrders(userId: string, email?: string | null): Promise<CustomerOrderRow[]> {
  const normalizedEmail = (email ?? "").trim().toLowerCase();
  // Match on the account id first (survives an email change and works for
  // phone-only accounts that have no email), OR the current email for legacy
  // orders placed before customer_user_id was stored.
  const orFilter = normalizedEmail
    ? `customer_user_id.eq.${userId},customer_email.ilike.${normalizedEmail}`
    : `customer_user_id.eq.${userId}`;

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, amount_paid, payment_status, fulfillment_status, tracking_number, created_at, order_items(product_id, product_name, quantity, line_total, unit_price)")
    .or(orFilter)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    throw error;
  }

  return (data ?? []).map((order) => ({
    orderId: String(order.order_id),
    amountPaid: Number(order.amount_paid ?? 0),
    paymentStatus: String(order.payment_status ?? ""),
    fulfillmentStatus: String(order.fulfillment_status ?? ""),
    trackingNumber: order.tracking_number ? String(order.tracking_number) : null,
    createdAt: String(order.created_at),
    items: (order.order_items ?? []).map((item) => ({
      productId: String(item.product_id ?? ""),
      productName: String(item.product_name ?? item.product_id ?? "Item"),
      quantity: Number(item.quantity ?? 0),
      lineTotal: Number(item.line_total ?? 0),
      unitPrice: Number(item.unit_price ?? 0),
    })),
  }));
}

export interface CustomerAddress {
  id: string;
  label: string | null;
  fullName: string;
  address: string;
  city: string;
  postalCode: string;
  isDefault: boolean;
}

export async function getCustomerAddresses(userId: string): Promise<CustomerAddress[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_addresses")
    .select("id, label, full_name, address, city, postal_code, is_default")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    label: row.label ? String(row.label) : null,
    fullName: String(row.full_name),
    address: String(row.address),
    city: String(row.city),
    postalCode: String(row.postal_code),
    isDefault: Boolean(row.is_default),
  }));
}

export async function getDefaultCustomerAddress(userId: string): Promise<CustomerAddress | null> {
  const addresses = await getCustomerAddresses(userId);
  return addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;
}

export interface CustomerPreferences {
  orderUpdateEmails: boolean;
  marketingEmails: boolean;
  birthday: string | null;
  phone: string | null;
  referralCode: string | null;
  referredByCode: string | null;
}

export async function getCustomerPreferences(userId: string): Promise<CustomerPreferences> {
  // `phone` is read tolerantly: if the customer-phone.sql migration hasn't been
  // applied yet, selecting the column would error and break the whole settings
  // page. Trying it first and falling back to the pre-phone column set makes
  // the deploy order (code vs. SQL) not matter.
  let data: Record<string, unknown> | null = null;
  const withPhone = await supabaseAdmin
    .from("customer_preferences")
    .select("order_update_emails, marketing_emails, birthday, phone, referral_code, referred_by_code")
    .eq("user_id", userId)
    .maybeSingle();

  if (withPhone.error) {
    const fallback = await supabaseAdmin
      .from("customer_preferences")
      .select("order_update_emails, marketing_emails, birthday, referral_code, referred_by_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (fallback.error) {
      throw fallback.error;
    }
    data = fallback.data as Record<string, unknown> | null;
  } else {
    data = withPhone.data as Record<string, unknown> | null;
  }

  return {
    orderUpdateEmails: data ? Boolean(data.order_update_emails) : true,
    marketingEmails: data ? Boolean(data.marketing_emails) : false,
    birthday: data?.birthday ? String(data.birthday) : null,
    phone: data?.phone ? String(data.phone) : null,
    referralCode: data?.referral_code ? String(data.referral_code) : null,
    referredByCode: data?.referred_by_code ? String(data.referred_by_code) : null,
  };
}

function generateReferralCode() {
  return randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

// Lazily generates a referral code on first use rather than at signup, so
// accounts that never share a referral link never need one.
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await supabaseAdmin
    .from("customer_preferences")
    .select("referral_code")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.data?.referral_code) {
    return String(existing.data.referral_code);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    const { error } = await supabaseAdmin
      .from("customer_preferences")
      .upsert({ user_id: userId, referral_code: code, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

    if (!error) {
      return code;
    }

    if (error.code !== "23505") {
      throw error;
    }
  }

  throw new Error("Unable to generate a unique referral code");
}

export async function getUserIdByReferralCode(code: string): Promise<string | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("customer_preferences")
    .select("user_id")
    .eq("referral_code", normalized)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? String(data.user_id) : null;
}

export async function setReferredByCode(userId: string, referredByCode: string) {
  const normalized = referredByCode.trim().toUpperCase();
  if (!normalized) {
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from("customer_preferences")
    .select("referred_by_code")
    .eq("user_id", userId)
    .maybeSingle();

  // Only ever set once, at signup - never overwrite an existing value.
  if (existing?.referred_by_code) {
    return;
  }

  await supabaseAdmin
    .from("customer_preferences")
    .upsert({ user_id: userId, referred_by_code: normalized, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
}

export async function setCustomerBirthday(userId: string, birthday: string) {
  const { error } = await supabaseAdmin
    .from("customer_preferences")
    .upsert({ user_id: userId, birthday, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  if (error) {
    throw error;
  }
}

// Saves (or clears, when passed an empty string) an optional contact phone
// number. The caller is responsible for validating format; this only stores
// the already-normalized value.
export async function setCustomerPhone(userId: string, phone: string) {
  const { error } = await supabaseAdmin
    .from("customer_preferences")
    .upsert({ user_id: userId, phone: phone || null, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  if (error) {
    throw error;
  }
}

export async function getWishlistSlugs(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("wishlist_items")
    .select("product_slug")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => String(row.product_slug));
}
