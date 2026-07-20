import "server-only";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

export class SendgridEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    const apiKey = process.env.SENDGRID_API_KEY;
    const from = process.env.EMAIL_FROM ?? process.env.SMTP_FROM;

    if (!apiKey || !from) {
      return {
        success: false,
        error: "SendGrid is not configured. Set SENDGRID_API_KEY and EMAIL_FROM.",
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
