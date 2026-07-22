import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/send";
import { contactFormNotificationTemplate, contactFormAutoReplyTemplate } from "@/lib/email/templates";
import { getBusinessSettings } from "@/lib/admin-control";
import { checkRateLimit, rateLimitedResponseBody } from "@/lib/rate-limit";

const SUBMISSION_WINDOW_MS = 3000;

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

function getClientKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "unknown";
  return forwardedFor.split(",")[0].trim() || "unknown";
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

    const limit = await checkRateLimit({ action: "contact", identifier: getClientKey(request), limit: 3, windowSeconds: 600 });
    if (!limit.allowed) {
      return NextResponse.json(rateLimitedResponseBody("Please wait before sending another message."), { status: 429 });
    }

    const { supportEmail } = await getBusinessSettings();
    const template = contactFormNotificationTemplate({ firstName, lastName, email, orderNumber, subject, message });
    const result = await sendEmail({ to: supportEmail, replyTo: email, ...template });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Email delivery is not configured." },
        { status: 500 },
      );
    }

    // Best-effort confirmation to the customer. A failure here must not fail
    // the submission — the team already received the message above.
    try {
      const autoReply = contactFormAutoReplyTemplate({ firstName, subject, message });
      await sendEmail({ to: email, replyTo: supportEmail, ...autoReply });
    } catch {
      // Non-fatal.
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}