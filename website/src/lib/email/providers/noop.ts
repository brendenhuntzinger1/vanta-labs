import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EmailMessage, EmailProvider, EmailSendResult } from "@/lib/email/types";

// Used when EMAIL_PROVIDER is set to an unrecognized value. Never throws —
// callers (e.g. approving a partner) must still succeed even with email
// unconfigured — but never pretends to have sent anything either.
//
// ---------------------------------------------------------------------------
// WHY IT CAN ALSO WRITE THE WHOLE MESSAGE DOWN.
//
// The log line below names the subject and the recipient and nothing else, so
// the only email facts a test could assert were "something went to this address
// with this subject". Whether the message CONTAINED the confirmation link, or a
// working one, or any link at all, was unobservable.
//
// That is not a hypothetical gap. qa-customer-journey.mjs proves "the
// confirmation link stays on our own domain" and "following the link verifies
// the account" against a URL it BUILDS ITSELF:
//
//     const confirmUrl = `${BASE}/auth/confirm?token=harness-hashed-${userId}&…`
//
// which is a fine way to test the /auth/confirm route and no way at all to test
// the email. A confirmation that arrived with a broken link, a link to the
// wrong host, or no link would have passed every check. Customers reporting
// exactly that — a verification mail they could not act on — is what started
// this work.
//
// So when EMAIL_CAPTURE_DIR is set, the full rendered message is appended as
// one JSON line per send, and a test can read what the customer would read.
//
// WHAT KEEPS IT OUT OF PRODUCTION, and what does not.
//
// A file of rendered emails is a file of password-reset links and confirmation
// tokens, so this needs a real guard. Two things provide it, and a third that
// looks like it does not:
//
//   * EMAIL_CAPTURE_DIR is unset everywhere except the harness. Nothing enables
//     it by default.
//   * THIS PROVIDER ONLY RUNS WHEN NO REAL ONE IS CONFIGURED. A production
//     store with Resend, SendGrid or SMTP set never constructs it, so the code
//     below is unreachable there whatever the variable says.
//
// It deliberately does NOT check NODE_ENV. `next build` bundles a server chunk
// with `process.env.NODE_ENV` folded to the literal "production" — the same
// constant-folding that makes the PAYMENT_PROVIDER guard unconditional in a
// built app — so `if (process.env.NODE_ENV === "production") return null` is
// always true and silently disables capture in the harness too. It read like a
// safety check and was an off switch.
// ---------------------------------------------------------------------------

function captureDir(): string | null {
  return (process.env.EMAIL_CAPTURE_DIR ?? "").trim() || null;
}

export class NoopEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.warn(
      `[email] No provider configured for EMAIL_PROVIDER="${process.env.EMAIL_PROVIDER ?? ""}". ` +
        `Not sent: "${message.subject}" to ${message.to}.`,
    );

    const dir = captureDir();
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, "captured-emails.jsonl"),
          `${JSON.stringify({
            at: new Date().toISOString(),
            to: message.to,
            subject: message.subject,
            html: message.html ?? "",
            text: message.text ?? "",
            // The HEADERS matter as much as the body, and were the one thing a
            // captured message could not answer. Whether a send carried
            // List-Unsubscribe is the whole transactional/marketing
            // separation, and reading it off the captured message is the only
            // way to see what a mailbox provider will see.
            replyTo: message.replyTo ?? "",
            headers: message.headers ?? {},
          })}\n`,
          "utf8",
        );
      } catch {
        // Capturing is a testing convenience. It must never be the reason a
        // send path fails, which is the whole contract of this provider.
      }
    }

    return { success: false, provider: "none", error: "No email provider configured." };
  }
}
