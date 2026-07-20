import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/send";
import { contactFormNotificationTemplate } from "@/lib/email/templates";
import { getBusinessSettings } from "@/lib/admin-control";

const SUBMISSION_WINDOW_MS = 3000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 3;

const submissionHistory = new Map<string, number[]>();

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

function isRateLimited(clientKey: string) {
  const now = Date.now();
  const history = submissionHistory.get(clientKey) ?? [];
  const recentHistory = history.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (recentHistory.length >= MAX_SUBMISSIONS_PER_WINDOW) {
    submissionHistory.set(clientKey, recentHistory);
    return true;
  }

  recentHistory.push(now);
  submissionHistory.set(clientKey, recentHistory);
  return false;
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

    if (isRateLimited(getClientKey(request))) {
      return NextResponse.json({ success: false, error: "Please wait before sending another message." }, { status: 429 });
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

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}