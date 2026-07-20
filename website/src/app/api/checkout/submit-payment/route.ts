import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { uploadPaymentProof } from "@/lib/payment-proof-storage";
import { sendEmail } from "@/lib/email/send";
import { manualPaymentReceivedTemplate } from "@/lib/email/templates";

export const dynamic = "force-dynamic";

// Customer-facing: submit proof of a manual payment (Cash App / Zelle /
// PayPal). Identified by the unguessable order UUID (the same bearer-token
// pattern as the hosted-checkout return URL). Moves the order into
// "awaiting_verification" for an admin to approve, stores the transaction id
// and optional screenshot, and emails a confirmation that payment is under
// review. Accepts multipart/form-data so the screenshot can be uploaded in
// the same request.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const orderId = String(formData.get("orderId") ?? "").trim();
    const transactionId = String(formData.get("transactionId") ?? "").trim();
    const screenshot = formData.get("screenshot");

    if (!orderId) {
      return NextResponse.json({ success: false, error: "Missing order reference." }, { status: 400 });
    }

    if (!transactionId) {
      return NextResponse.json({ success: false, error: "Enter your payment transaction / confirmation ID." }, { status: 400 });
    }

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_email, customer_name, amount_paid, payment_method, payment_status")
      .eq("order_id", orderId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    }

    if (order.payment_status === "paid") {
      return NextResponse.json({ success: false, error: "This order has already been paid." }, { status: 400 });
    }

    // Only manual methods use this flow.
    if (!order.payment_method || order.payment_method === "card") {
      return NextResponse.json({ success: false, error: "This order does not use a manual payment method." }, { status: 400 });
    }

    let proofUrl: string | null = null;
    let uploadWarning: string | undefined;
    if (screenshot instanceof File && screenshot.size > 0) {
      const uploaded = await uploadPaymentProof({ orderId, file: screenshot });
      proofUrl = uploaded.url;
      uploadWarning = uploaded.error;
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({
        payment_status: "awaiting_verification",
        payment_reference: transactionId.slice(0, 200),
        payment_proof_url: proofUrl,
        payment_submitted_at: now,
        // Clear any prior rejection so a resubmission starts clean.
        rejection_reason: null,
        payment_rejected_at: null,
        updated_at: now,
      })
      .eq("order_id", orderId);

    if (updateError) {
      throw updateError;
    }

    if (order.customer_email) {
      const template = manualPaymentReceivedTemplate({
        customerName: String(order.customer_name ?? ""),
        orderNumber: String(order.order_number ?? order.order_id),
        amount: Number(order.amount_paid ?? 0),
        paymentMethod: String(order.payment_method ?? ""),
      });
      await sendEmail({ to: String(order.customer_email), ...template });
    }

    return NextResponse.json({ success: true, uploadWarning });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to submit payment.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
