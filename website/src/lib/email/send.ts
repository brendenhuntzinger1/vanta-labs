import "server-only";
import { getEmailProvider } from "@/lib/email/provider";
import type { EmailMessage, EmailSendResult, EmailTemplate } from "@/lib/email/types";

// Never throws. Callers that trigger an email as a side effect of some
// other action (approving a partner, marking an order paid) must not fail
// that action just because email isn't configured or a provider call
// errors — this always resolves, and the caller decides what (if anything)
// to do with a failed result (e.g. log it, queue for retry).
export async function sendEmail(input: { to: string; replyTo?: string } & EmailTemplate): Promise<EmailSendResult> {
  const message: EmailMessage = {
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  };

  try {
    const provider = await getEmailProvider();
    return await provider.send(message);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unable to send email" };
  }
}
