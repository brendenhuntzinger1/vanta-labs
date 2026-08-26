import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/send";
import { wholesaleInquiryAutoReplyTemplate, wholesaleInquiryNotificationTemplate } from "@/lib/email/templates";
import { getBusinessSettings } from "@/lib/admin-control";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { customerSafeMessage } from "@/lib/safe-error";

/**
 * Wholesale enquiries.
 *
 * A deliberate copy of the contact form's protections rather than a new
 * mechanism: same honeypot, same minimum fill time, same per-IP rate limit,
 * same length caps, same support inbox, same escaping in the template. A second
 * public form with weaker defences than the first is how spam finds a site.
 *
 * The honeypot field is `website`, not `company` — the contact form uses
 * `company` as its trap, and this form has a real organisation field. Reusing
 * that name would have made every genuine submission from a named company look
 * like a bot.
 */

const SUBMISSION_WINDOW_MS = 3000;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const MAX_SUBMISSIONS_PER_WINDOW = 3;

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 200;
const MAX_SHORT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type WholesaleBody = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  organization?: string;
  volume?: string;
  products?: string;
  message?: string;
  /** Honeypot. Real people never see it, so anything here is a bot. */
  website?: string;
  startedAt?: string;
};

const parseString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as WholesaleBody;

    const firstName = parseString(body.firstName);
    const lastName = parseString(body.lastName);
    const email = parseString(body.email);
    const phone = parseString(body.phone);
    const organization = parseString(body.organization);
    const volume = parseString(body.volume);
    const products = parseString(body.products);
    const message = parseString(body.message);
    const honeypot = parseString(body.website);
    const startedAt = Number(body.startedAt);

    if (honeypot) {
      return NextResponse.json({ success: false, error: "Submission rejected." }, { status: 400 });
    }

    if (!Number.isFinite(startedAt) || Date.now() - startedAt < SUBMISSION_WINDOW_MS) {
      return NextResponse.json({ success: false, error: "Please try submitting the form again." }, { status: 400 });
    }

    if (!firstName || !lastName || !email || !message) {
      return NextResponse.json({ success: false, error: "Please complete all required fields." }, { status: 400 });
    }

    if (
      firstName.length > MAX_NAME_LENGTH ||
      lastName.length > MAX_NAME_LENGTH ||
      email.length > MAX_EMAIL_LENGTH ||
      phone.length > MAX_SHORT_LENGTH ||
      organization.length > MAX_SHORT_LENGTH ||
      volume.length > MAX_SHORT_LENGTH ||
      products.length > MAX_SHORT_LENGTH ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      return NextResponse.json(
        { success: false, error: "One or more fields exceed the maximum allowed length." },
        { status: 400 },
      );
    }

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ success: false, error: "Please provide a valid email address." }, { status: 400 });
    }

    const rateLimit = await checkRateLimit(
      rateLimitKeyForRequest("wholesale", request),
      MAX_SUBMISSIONS_PER_WINDOW,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Please wait before sending another request." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const { supportEmail } = await getBusinessSettings();
    const template = wholesaleInquiryNotificationTemplate({
      firstName,
      lastName,
      email,
      phone,
      organization,
      volume,
      products,
      message,
    });
    const result = await sendEmail({ to: supportEmail, replyTo: email, ...template });

    if (!result.success) {
      // Told honestly. A form that says "thanks!" when nothing was delivered
      // costs a wholesale lead and nobody ever finds out why.
      return NextResponse.json(
        { success: false, error: result.error ?? "Email delivery is not configured." },
        { status: 500 },
      );
    }

    // Best-effort. The business already has the enquiry, so a failed
    // confirmation must not turn a delivered lead into an error on screen.
    try {
      await sendEmail({ to: email, replyTo: supportEmail, ...wholesaleInquiryAutoReplyTemplate({ firstName }) });
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[wholesale]", error);
    const message = customerSafeMessage(error, "Unable to send request");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
