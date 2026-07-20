import "server-only";
import type { EmailProvider } from "@/lib/email/types";
import { SmtpEmailProvider } from "@/lib/email/providers/smtp";
import { ResendEmailProvider } from "@/lib/email/providers/resend";
import { SendgridEmailProvider } from "@/lib/email/providers/sendgrid";
import { NoopEmailProvider } from "@/lib/email/providers/noop";

export type EmailProviderName = "smtp" | "resend" | "sendgrid";

// Selects the email backend from EMAIL_PROVIDER so switching providers is a
// pure env-var change, no code change. Defaults to "smtp" since that's the
// long-standing configuration this app already documents (SMTP_* vars) —
// unset EMAIL_PROVIDER does not mean "no provider," it means "use SMTP."
export function getEmailProvider(providerName = process.env.EMAIL_PROVIDER ?? "smtp"): EmailProvider {
  switch (providerName.toLowerCase()) {
    case "smtp":
      return new SmtpEmailProvider();
    case "resend":
      return new ResendEmailProvider();
    case "sendgrid":
      return new SendgridEmailProvider();
    default:
      return new NoopEmailProvider();
  }
}
