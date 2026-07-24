import "server-only";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

export interface SendgridProviderConfig {
  apiKey: string;
  from: string;
}

export class SendgridEmailProvider implements EmailProvider {
  // Optional config for backward compatibility; falls back to env when omitted.
  // Symmetric with ResendEmailProvider so the admin-configured path (key pasted
  // into the dashboard, resolved in settings.ts) and the env path both work —
  // otherwise settings.ts/isReady() could report SendGrid "ready" while every
  // send silently fell back to an unset env var.
  constructor(private readonly config?: SendgridProviderConfig) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const apiKey = this.config?.apiKey ?? process.env.SENDGRID_API_KEY;
    const from = this.config?.from ?? process.env.EMAIL_FROM ?? process.env.SMTP_FROM;

    if (!apiKey || !from) {
      return {
        success: false,
        error: "SendGrid is not configured. Set the SendGrid API key and from address.",
      };
    }

    try {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: from },
          reply_to: message.replyTo ? { email: message.replyTo } : undefined,
          subject: message.subject,
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { success: false, error: `SendGrid API error (${response.status}): ${body.slice(0, 300)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "SendGrid send failed" };
    }
  }
}
