import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

const SUPPORT_EMAIL = "support@vantalabsresearch.com";
const SUBMISSION_WINDOW_MS = 3000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 3;

const submissionHistory = new Map<string, number[]>();

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

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const secure = String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";

  if (!host || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
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

    if (isRateLimited(getClientKey(request))) {
      return NextResponse.json({ success: false, error: "Please wait before sending another message." }, { status: 429 });
    }

    const transport = getTransport();
    if (!transport) {
      return NextResponse.json(
        {
          success: false,
          error: "Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD.",
        },
        { status: 500 },
      );
    }

    const replyLines = [
      `Name: ${firstName} ${lastName}`,
      `Email: ${email}`,
      orderNumber ? `Order Number: ${orderNumber}` : null,
      "",
      message,
    ].filter((line): line is string => line !== null);

    await transport.sendMail({
      from: process.env.SMTP_FROM ?? `Vanta Labs <${SUPPORT_EMAIL}>`,
      to: SUPPORT_EMAIL,
      replyTo: email,
      subject: `Vanta Labs Contact Form - ${subject}`,
      text: replyLines.join("\n"),
      html: replyLines
        .map((line) => (line ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : "<br />"))
        .join(""),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}