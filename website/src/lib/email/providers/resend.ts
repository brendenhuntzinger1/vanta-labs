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
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Resend collapses repeat requests carrying the same key. This is the
          // only guard that survives our own process dying between "Resend
          // accepted it" and "we wrote that down".
          ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          reply_to: message.replyTo,
          // List-Unsubscribe and friends. Resend puts these on the wire
          // verbatim; without them a bulk send has no one-click opt-out, which
          // Gmail and Yahoo have required of bulk senders since Feb 2024.
          ...(message.headers && Object.keys(message.headers).length
            ? { headers: message.headers }
            : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { success: false, provider: "resend", error: `Resend API error (${response.status}): ${body.slice(0, 300)}` };
      }

      // Resend answers with { id: "..." } and this used to discard it. That id
      // is what turns "we think we sent it" into something checkable against
      // Resend's own dashboard, so it is read here — but never at the cost of
      // the send: a body that fails to parse still counts as accepted, because
      // the API already returned 2xx.
      let providerMessageId: string | undefined;
      try {
        const body = (await response.json()) as { id?: unknown };
        if (typeof body?.id === "string" && body.id) providerMessageId = body.id;
      } catch {
        /* accepted, id unavailable */
      }
      return { success: true, provider: "resend", providerMessageId };
    } catch (error) {
      return { success: false, provider: "resend", error: error instanceof Error ? error.message : "Resend send failed" };
    }
  }
}
