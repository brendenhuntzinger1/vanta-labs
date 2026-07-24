import "server-only";
import type { EmailProvider } from "@/lib/email/types";
import { SmtpEmailProvider } from "@/lib/email/providers/smtp";
import { ResendEmailProvider } from "@/lib/email/providers/resend";
import { SendgridEmailProvider } from "@/lib/email/providers/sendgrid";
import { NoopEmailProvider } from "@/lib/email/providers/noop";
import { getEmailRuntimeConfig, type EmailProviderName } from "@/lib/email/settings";

export type { EmailProviderName };

// Resolves the active email backend from the admin-editable settings (layered
// over env). Email is DISABLED by default: until an operator enables it and
// supplies the chosen provider's credentials, this returns the no-op provider
// so nothing is sent and no email-triggering action ever fails. Once enabled
// and configured, every transactional email flows through the selected
// provider automatically.
export async function getEmailProvider(): Promise<EmailProvider> {
  const config = await getEmailRuntimeConfig();

  if (!config.enabled) {
    return new NoopEmailProvider();
  }

  switch (config.provider) {
    case "resend":
      return new ResendEmailProvider({ apiKey: config.resend.apiKey, from: config.from });
    case "sendgrid":
      return new SendgridEmailProvider({ apiKey: config.sendgrid.apiKey, from: config.from });
    case "smtp":
    default:
      return new SmtpEmailProvider({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        user: config.smtp.user,
        password: config.smtp.password,
        from: config.from,
      });
  }
}
