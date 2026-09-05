import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/send";
import { contactFormNotificationTemplate, contactFormAutoReplyTemplate } from "@/lib/email/templates";
import { plainGreetingName } from "@/lib/email/greeting-name";
import { getBusinessSettings } from "@/lib/admin-control";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { customerSafeMessage } from "@/lib/safe-error";

const SUBMISSION_WINDOW_MS = 3000;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const MAX_SUBMISSIONS_PER_WINDOW = 3;

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 200;
const MAX_ORDER_NUMBER_LENGTH = 100;
const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ContactBody = {
  firstName?: string;
  lastName?: string;
  email?: string;
  orderNumber?: string;
  subject?: string;
  message?: string;
  company?: string;
  startedAt?: string;
};

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContactBody;

    const firstName = parseString(body.firstName);
    const lastName = parseString(body.lastName);
    const email = parseString(body.email);
    const orderNumber = parseString(body.orderNumber);
    const subject = parseString(body.subject);
    const message = parseString(body.message);
    const company = parseString(body.company);
    const startedAt = Number(body.startedAt);

    if (company) {
      return NextResponse.json({ success: false, error: "Submission rejected." }, { status: 400 });
    }

    if (!Number.isFinite(startedAt) || Date.now() - startedAt < SUBMISSION_WINDOW_MS) {
      return NextResponse.json({ success: false, error: "Please try submitting the form again." }, { status: 400 });
    }

    if (!firstName || !lastName || !email || !subject || !message) {
      return NextResponse.json({ success: false, error: "Please complete all required fields." }, { status: 400 });
    }

    if (
      firstName.length > MAX_NAME_LENGTH ||
      lastName.length > MAX_NAME_LENGTH ||
      email.length > MAX_EMAIL_LENGTH ||
      orderNumber.length > MAX_ORDER_NUMBER_LENGTH ||
      subject.length > MAX_SUBJECT_LENGTH ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      return NextResponse.json({ success: false, error: "One or more fields exceed the maximum allowed length." }, { status: 400 });
    }

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ success: false, error: "Please provide a valid email address." }, { status: 400 });
    }

    const rateLimit = await checkRateLimit(
      rateLimitKeyForRequest("contact", request),
      MAX_SUBMISSIONS_PER_WINDOW,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Please wait before sending another message." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const { supportEmail } = await getBusinessSettings();
    const template = contactFormNotificationTemplate({ firstName, lastName, email, orderNumber, subject, message });
    const result = await sendEmail({ to: supportEmail, replyTo: email, ...template });

    if (!result.success) {
      // The provider's own text names the vendor and can carry an API status
      // ("Resend API error (401): ..."). It is exactly what safe-error.ts exists
      // to keep off a customer's screen, and this endpoint is anonymous.
      console.error("[contact] notification send failed:", result.error);
      return NextResponse.json(
        { success: false, error: "We couldn't send your message just now. Please try again shortly." },
        { status: 500 },
      );
    }

    // Best-effort confirmation to the customer. A failure here must not fail
    // the submission — the team already received the message above.
    //
    // NOTHING THE POSTER TYPED IS ECHOED. This is an anonymous form and the
    // reply goes to whatever address was entered, from the identity that
    // carries receipts and password resets. Quoting the subject and 5,000
    // characters of message back made it a relay: anyone could have arbitrary
    // text delivered, Vanta-branded, to any inbox, and the spam complaints
    // land on the transactional domain. The template now says only what the
    // store has to say; the greeting name is held to the shape of a name.
    try {
      const autoReply = contactFormAutoReplyTemplate({ firstName: plainGreetingName(firstName) });
      await sendEmail({ to: email, replyTo: supportEmail, ...autoReply });
    } catch {
      // Non-fatal.
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // Sanitised rather than echoed. safe-error.ts:5-16 is explicit that a raw
    // message hands a shopper a vendor hostname, a Postgres relation/column
    // name or an env-var name. Logged in full server-side, so no diagnostic
    // is lost; a genuinely shopper-written message still passes through,
    // because the sanitiser is a deny-list.
    console.error("[contact]", error);
    const message = customerSafeMessage(error, "Unable to send message");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}