import "server-only";
import nodemailer from "nodemailer";
import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

// Generic SMTP transport. Also covers AWS SES: SES exposes an SMTP
// interface with its own host/username/password, so pointing SMTP_HOST at
// your SES SMTP endpoint works without a separate provider implementation.
export interface SmtpProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export class SmtpEmailProvider implements EmailProvider {
  // Config is optional for backward compatibility: when omitted the provider
  // reads the SMTP_* environment variables as before. The admin-configured
  // path passes an explicit config resolved in src/lib/email/settings.ts.
  constructor(private readonly config?: SmtpProviderConfig) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const host = this.config?.host ?? process.env.SMTP_HOST;
    const user = this.config?.user ?? process.env.SMTP_USER;
    const pass = this.config?.password ?? process.env.SMTP_PASSWORD;
    const from = this.config?.from ?? process.env.SMTP_FROM ?? process.env.EMAIL_FROM;

    if (!host || !user || !pass || !from) {
      return {
        success: false,
        error: "SMTP is not configured. Set the SMTP host, user, password, and from address.",
      };
    }

    const port = this.config?.port ?? Number(process.env.SMTP_PORT ?? "587");
    const secure = this.config?.secure ?? (String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true");

    try {
      const transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });

      const info = await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
      });

      // NOT THROWING IS NOT THE SAME AS DELIVERED. nodemailer resolves rather
      // than rejects when a server refuses a recipient at RCPT TO — the refusal
      // comes back in `rejected` instead. This used to ignore the result
      // entirely and return success, so a 550 (unknown mailbox), a 421 (server
      // busy) or a 535 was recorded as a successful send: the campaign marked
      // that person delivered and never retried them, and the transactional
      // retry queue did the same with their receipt.
      //
      // `accepted` is the authority. An empty `accepted` with no exception is
      // the exact shape of a silently-dropped message.
      const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
      const asAddress = (entry: unknown): string =>
        (typeof entry === "string" ? entry : String((entry as { address?: string })?.address ?? "")).trim().toLowerCase();
      const target = message.to.trim().toLowerCase();

      if (rejected.some((entry) => asAddress(entry) === target) || accepted.length === 0) {
        const response = typeof info?.response === "string" ? info.response : "";
        return {
          success: false,
          // The server's own reply names the reason (mailbox unknown, over
          // quota, blocked) and is the only useful thing to put in a log.
          error: `SMTP recipient rejected${response ? `: ${response.slice(0, 200)}` : ""}`,
        };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "SMTP send failed" };
    }
  }
}
