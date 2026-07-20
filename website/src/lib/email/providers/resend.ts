import "server-only";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

export interface ResendProviderConfig {
  apiKey: string;
  from: string;
}

export class ResendEmailProvider implements EmailProvider {
  // Optional config for backward compatibility; falls back to env when omitted.
  constructor(private readonly config?: ResendProviderConfig) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const apiKey = this.config?.apiKey ?? process.env.RESEND_API_KEY;
    const from = this.config?.from ?? process.env.EMAIL_FROM ?? process.env.SMTP_FROM;

    if (!apiKey || !from) {
      return {
        success: false,
        error: "Resend is not configured. Set the Resend API key and from address.",
      };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          reply_to: message.replyTo,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { success: false, error: `Resend API error (${response.status}): ${body.slice(0, 300)}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Resend send failed" };
    }
  }
}
