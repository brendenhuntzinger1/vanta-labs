import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

// Used when EMAIL_PROVIDER is set to an unrecognized value. Never throws —
// callers (e.g. approving a partner) must still succeed even with email
// unconfigured — but never pretends to have sent anything either.
export class NoopEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.warn(
      `[email] No provider configured for EMAIL_PROVIDER="${process.env.EMAIL_PROVIDER ?? ""}". ` +
        `Not sent: "${message.subject}" to ${message.to}.`,
    );
    return { success: false, error: "No email provider configured." };
  }
}
