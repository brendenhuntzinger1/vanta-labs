export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * A stable key identifying THIS message, so the provider itself refuses a
   * duplicate.
   *
   * Our own send-once claim is taken before the provider is called, which stops
   * two callers both sending. It cannot cover the one gap underneath: the
   * provider accepts the message and this process dies before recording that it
   * did. Our row stays 'sending', which blocks a resend — correct, but it
   * depends on us. A provider-side key makes the guarantee hold even if our
   * bookkeeping is wrong in either direction.
   *
   * Honoured by Resend (Idempotency-Key). Ignored by providers without the
   * capability, where our claim remains the only guard.
   */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  success: boolean;
  error?: string;
  /**
   * The id the provider assigned to the message, when it gives one.
   *
   * This is the only handle that ties a row in our own logs to a message in
   * the provider's dashboard. Without it, "we recorded a successful send" and
   * "the provider actually accepted a message" are two claims with nothing
   * joining them, and a delivery dispute has no thread to pull. Absent for a
   * provider that returns no id, and never required for correctness.
   */
  providerMessageId?: string;
  /** Which backend handled it — 'resend' | 'sendgrid' | 'smtp'. */
  provider?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}
