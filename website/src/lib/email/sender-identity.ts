// -------------------------------------------------------------------------
// Who a Vanta Labs email says it is from.
//
// Template BODIES are already swept for other companies' names
// (templates-sweep.test.ts). The sender line was not — and it is the most
// visible line in the message. It arrives as free text from an admin field or
// an env var, so one paste of `Evo Labs <orders@evolabs.com>` re-brands every
// transactional email the store sends, in the inbox list, before anything is
// opened. That is the exact failure this exists to stop.
//
// Two different problems, two different answers:
//
//   Wrong display NAME  → rewritten to "Vanta Labs". The address is fine, only
//                          the label was wrong; rewriting keeps mail flowing.
//   Wrong sending DOMAIN → blocked. There is no honest repair — we cannot
//                          invent a Vanta sending domain — and sending it
//                          anyway would put another company's address in front
//                          of a Vanta customer. Fail closed, and let the admin
//                          System Status say why.
//
// Blocking stops email rather than mis-branding it. That is the deliberate
// trade: a missing receipt is a support ticket, a competitor's name on a Vanta
// customer's receipt is the problem we were asked to end.
// -------------------------------------------------------------------------

/** The one name a Vanta Labs email may present itself under. */
export const VANTA_SENDER_NAME = "Vanta Labs";

// Companies in this system's supply chain that must never appear as the sender
// of customer mail: the fulfilment provider, the payment gateway, the vaulting
// vendor. Same list the template sweep asserts against.
const FOREIGN_BRAND = /evo\s*labs|evolabs|arcline|basis\s*theory|basistheory|veyra|veyragate/i;

export interface SenderIdentity {
  /** The header value to send, or null when sending must not happen. */
  from: string | null;
  displayName: string;
  address: string;
  /** True when the display name was corrected to Vanta Labs. */
  nameRewritten: boolean;
  /** True when the sending address itself is unusable — do not send. */
  blocked: boolean;
  /** Plain-English cause, for admin System Status. Empty when all is well. */
  reason: string;
}

/** Split `Name <addr@host>` / `addr@host` into its parts. */
function parseFrom(raw: string): { displayName: string; address: string } {
  const trimmed = String(raw ?? "").trim();
  const angled = trimmed.match(/^(.*?)<\s*([^>]+)\s*>$/);
  if (angled) {
    return {
      displayName: angled[1].trim().replace(/^["']|["']$/g, "").trim(),
      address: angled[2].trim(),
    };
  }
  return { displayName: "", address: trimmed };
}

function looksLikeEmail(address: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(address);
}

/**
 * Resolve the sender line every outgoing customer email must use.
 *
 * Always returns Vanta Labs as the display name, or blocks the send.
 */
export function resolveSenderIdentity(rawFrom: string | null | undefined): SenderIdentity {
  const raw = String(rawFrom ?? "").trim();

  if (!raw) {
    return {
      from: null,
      displayName: VANTA_SENDER_NAME,
      address: "",
      nameRewritten: false,
      blocked: true,
      reason: "No From address is configured, so no email can be sent.",
    };
  }

  const { displayName, address } = parseFrom(raw);

  if (!looksLikeEmail(address)) {
    return {
      from: null,
      displayName: VANTA_SENDER_NAME,
      address,
      nameRewritten: false,
      blocked: true,
      reason: `The From address ("${raw}") is not a valid email address.`,
    };
  }

  // The address belongs to another company. Nothing to rewrite — the mail would
  // genuinely come from them.
  if (FOREIGN_BRAND.test(address)) {
    return {
      from: null,
      displayName: VANTA_SENDER_NAME,
      address,
      nameRewritten: false,
      blocked: true,
      reason:
        `The From address ("${address}") belongs to another company. Vanta Labs customer email is ` +
        `blocked until it is changed to a Vanta Labs address.`,
    };
  }

  // The address is ours; only the label was wrong (or missing). Rewrite it.
  const nameIsForeign = Boolean(displayName) && FOREIGN_BRAND.test(displayName);
  const nameRewritten = nameIsForeign || displayName !== VANTA_SENDER_NAME;

  return {
    from: `${VANTA_SENDER_NAME} <${address}>`,
    displayName: VANTA_SENDER_NAME,
    address,
    nameRewritten,
    blocked: false,
    reason: nameIsForeign
      ? `The sender name was set to "${displayName}" and has been corrected to ${VANTA_SENDER_NAME}.`
      : "",
  };
}

/** True if any string names a company other than Vanta Labs. */
export function mentionsForeignBrand(value: string | null | undefined): boolean {
  return FOREIGN_BRAND.test(String(value ?? ""));
}
