/**
 * Is the referral programme accepting codes right now?
 *
 * `quote-order.ts` refuses any order still carrying a referral code while the
 * Control Center referral switch is off, and the client had no way to know:
 * `/api/catalog/promotions` sent the discount percent and the minimum but never
 * `enabled`, and the validation RPC returns nothing programme-level. An
 * ambassador link already in the wild therefore kept converting, the cart kept
 * previewing "15% customer discount", and the shopper was stopped at the pay
 * button with HTTP 400 — the one moment where a refusal costs the most.
 *
 * There is no server-only repair. Dropping the referral instead of throwing
 * makes the server's total HIGHER than the client's, and the underpayment guard
 * refuses the order anyway, with a worse message. The client has to be told.
 *
 * THREE STATES, NOT TWO. "Off" and "not known yet" are different answers:
 *
 *   true   on — behave exactly as before
 *   false  definitively off — attach nothing, apply nothing, promise nothing
 *   null   the config request has not landed yet
 *
 * Which way `null` leans is a decision about money. Leaning it toward OFF would
 * strip a legitimate discount from every referred shopper during any hiccup,
 * silently, in the store's favour. Leaning it toward ON preserves exactly the
 * previous behaviour for the milliseconds before the config lands, with the
 * server throw still underneath as the backstop. A FAILED read is not this
 * state: the promotions route's catch answers `true`, matching
 * `getReferralProgramConfig`'s own fallback, so client and server stay in
 * lockstep during an outage the way every other field in that payload does.
 */
export type ReferralProgramState = boolean | null | undefined;

/**
 * May the client attach, apply, or advertise a referral code?
 *
 * Everything the cart does with a code goes through this, so there is one
 * answer rather than one per surface.
 */
export function referralProgramAllowsCodes(state: ReferralProgramState): boolean {
  return state !== false;
}

/**
 * Is the programme DEFINITELY off?
 *
 * Deliberately separate from `!referralProgramAllowsCodes`, even though they
 * agree, because the call sites differ in what they risk. Discarding a
 * shopper's attached code is destructive and may only happen on a definite
 * answer — never on "not known yet".
 */
export function referralProgramIsOff(state: ReferralProgramState): boolean {
  return state === false;
}

/**
 * What a shopper is told when they type a code while the programme is paused.
 *
 * Not "invalid code": the code is real and so is the ambassador behind it.
 * Telling her it is invalid sends her back to that ambassador to ask for a
 * working one, which is a support ticket for both of them.
 */
export const REFERRAL_PROGRAM_PAUSED_MESSAGE =
  "The referral program is paused right now, so codes can't be applied.";
