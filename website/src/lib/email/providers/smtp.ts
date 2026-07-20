import "server-only";
import nodemailer from "nodemailer";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

// Generic SMTP transport. Also covers AWS SES: SES exposes an SMTP
// interface with its own host/username/password, so pointing SMTP_HOST at
// your SES SMTP endpoint works without a separate provider implementation.
export class SmtpEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    const from = process.env.SMTP_FROM ?? process.env.EMAIL_FROM;

    if (!host || !user || !pass || !from) {
      return {
        success: false,
        error: "SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM (or EMAIL_FROM).",
      };
    }

    const port = Number(process.env.SMTP_PORT ?? "587");
    const secure = String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";

    try {
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });

      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "SMTP send failed" };
    }
  }
}
