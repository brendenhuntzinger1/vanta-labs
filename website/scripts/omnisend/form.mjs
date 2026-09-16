import { PALETTE, SITE } from "./lib.mjs";

/**
 * The sign-up popup (spec §8): email first, an optional second step for SMS
 * with the store's own TCPA sentence, and a success screen pointing at the
 * catalogue. Restyled from Omnisend's email-and-SMS two-step template to the
 * site palette. post_forms creates it in DRAFT; the owner enables it after
 * review. Nothing here promises a discount amount, because the welcome code
 * is minted by the store and arrives by email within two days (site sign-ups
 * at once, form sign-ups after the nightly reconcile).
 *
 * Shape notes (post_forms schema, v2026-03-15, learned from its validator):
 *   - sections, rows, columns and blocks carry no ids (the server assigns them);
 *   - a block's preset key is `stylePresetID`; padding is four separate sides;
 *   - every colour is a hex value (rgba is refused), so the email hairlines
 *     are pre-blended over the surface colour below;
 *   - `fontFamily` must be one of Omnisend's own font stacks, so the site's
 *     Fraunces/Manrope pairing is not available here. Inter is the closest of
 *     the stacks the form templates ship with; the owner can swap it in the
 *     editor;
 *   - input and legal blocks require `styleProperties`;
 *   - text presets take one of five line heights; button presets need border,
 *     font and decoration fields;
 *   - `targeting.device` is a single value, so it is omitted to target both;
 *   - `targeting.location` entries are `{ code, name }`.
 */

export const FORM_FONT = "Inter, Helvetica Neue, Helvetica, Arial, sans-serif";

/** Site hairlines blended over the surfaces they sit on, as hex. */
const HEX = {
  overlay: "#0a0a0a",
  hairline: "#262626", // rgba(255,255,255,0.08) over #141414
  hairlineStrong: "#333333", // rgba(255,255,255,0.16) over #141414
  goldHairline: "#796c40", // rgba(199,174,94,0.55) over #1a1a1a
};

const p = (html, align = "left") => `<p style="margin:0;text-align:${align};">${html}</p>`;

function pad(top, right, bottom, left = right) {
  return { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left };
}

function text(html, preset, { align = "left", padding = pad("0px", "0px", "12px") } = {}) {
  return { type: "text", text: p(html, align), stylePresetID: preset, styleProperties: { ...padding, alignment: align } };
}

function button(label, type, preset = "primary_button", extra = {}) {
  return { type: "button", button: { text: label.toUpperCase(), type, isFullWidth: true, ...extra }, stylePresetID: preset, styleProperties: pad("8px", "0px", "0px") };
}

function step(blocks, padding = pad("36px", "32px", "36px")) {
  return { sections: [{ styleProperties: { backgroundColor: PALETTE.surface, opacity: 1, ...padding }, rows: [{ columns: [{ width: "100%", blocks }] }] }] };
}

/** The store's TCPA sentence, copied as written; never widened. */
export const SMS_CONSENT = "Yes, I would like to receive recurring automated marketing text messages from Vanta Labs at the number above. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to cancel at any time or HELP for help.";

export const PRIVACY_URL = `${SITE}/legal/privacy`;
export const TERMS_URL = `${SITE}/legal/terms`;
const legalLink = (href, label) => `<a href="${href}" style="color:${PALETTE.gold};text-decoration:underline;">${label}</a>`;

export function form() {
  const base = { fontFamily: FORM_FONT, fontSize: "13px", fontStyle: "normal", fontWeight: "bold", textDecoration: "none", textAlign: "center", paddingLeft: "24px", paddingRight: "24px", paddingTop: "14px", paddingBottom: "14px", borderRadius: "14px", borderStyle: "solid", borderWidth: "1px" };
  const field = pad("0px", "0px", "4px");
  return {
    name: "VL · Sign-up (email + SMS)",
    displayType: "popup",
    contactTags: ["form_subscriber", "source: omnisend-form"],
    clickOutside: { isEnabled: true },
    recaptcha: { isEnabled: true },
    targeting: {
      display: { afterSeconds: 12, isExitIntentEnabled: true },
      frequency: { type: "day", value: 7 },
      source: { excludes: ["omnisendCommunication"] },
      location: { includes: [{ code: "US", name: "United States" }, { code: "CA", name: "Canada" }] },
    },
    content: {
      generalSettings: {
        content: { color: HEX.overlay, width: "440px" },
        body: { backgroundColor: PALETTE.surface, borderRadius: "16px", borderStyle: "solid", borderWidth: "1px", borderColor: HEX.hairline },
        position: "middleCenter",
        closeButton: { color: PALETTE.muted, isVisible: true },
        link: { color: PALETTE.gold },
        fieldStyles: {
          errorColor: "#f09ca8",
          fontFamily: FORM_FONT,
          fontSize: "15px",
          field: { backgroundColor: PALETTE.background, borderColor: HEX.hairlineStrong, borderRadius: "12px", borderStyle: "solid", borderWidth: "1px", color: PALETTE.foreground, paddingTop: "14px", paddingBottom: "14px", paddingLeft: "16px", paddingRight: "16px" },
          label: { color: PALETTE.muted, paddingTop: "8px", paddingBottom: "8px", paddingLeft: "0px", paddingRight: "0px" },
          placeholder: { color: PALETTE.subtle },
        },
        buttonPresets: [
          { id: "primary_button", name: "Primary", styles: { ...base, backgroundColor: PALETTE.surfaceRaised, borderColor: HEX.goldHairline, color: PALETTE.buttonText } },
          { id: "secondary_button", name: "Secondary", styles: { ...base, backgroundColor: PALETTE.surface, borderColor: HEX.hairlineStrong, color: PALETTE.foreground } },
          { id: "tertiary_button", name: "Tertiary", styles: { ...base, backgroundColor: PALETTE.surface, borderWidth: "0px", borderColor: PALETTE.surface, color: PALETTE.gold, textDecoration: "underline" } },
        ],
        textPresets: [
          { id: "heading_large", name: "Heading Large", styles: { fontFamily: FORM_FONT, fontSize: "30px", color: PALETTE.foreground, lineHeight: "125%" } },
          { id: "heading_medium", name: "Heading Medium", styles: { fontFamily: FORM_FONT, fontSize: "24px", color: PALETTE.foreground, lineHeight: "125%" } },
          { id: "heading_small", name: "Heading Small", styles: { fontFamily: FORM_FONT, fontSize: "19px", color: PALETTE.foreground, lineHeight: "125%" } },
          { id: "paragraph", name: "Paragraph", styles: { fontFamily: FORM_FONT, fontSize: "15px", color: PALETTE.body, lineHeight: "150%" } },
          { id: "footnote", name: "Footnote", styles: { fontFamily: FORM_FONT, fontSize: "11px", color: PALETTE.subtle, lineHeight: "150%" } },
        ],
      },
      steps: [
        step([
          text("VANTA LABS", "footnote"),
          text("Batch reports, restocks and subscriber offers.", "heading_medium"),
          text("One or two emails a month. Every one links to the report for the batch it is about. Your welcome offer follows by email within two days.", "paragraph"),
          { type: "emailField", emailField: { label: "", placeholder: "Email address", isRequired: true, requiredMessage: "An email address is required", errorMessage: "That does not look like an email address" }, styleProperties: field },
          button("Subscribe", "submit"),
          text("For laboratory research use only. Not for human or veterinary use. Unsubscribe at any time.", "footnote", { padding: pad("12px", "0px", "0px") }),
        ]),
        step([
          // The brand name sits on this step too: a carrier reviewer sees the SMS
          // step alone as consent proof and must find the brand, the agreement,
          // an unticked box, STOP and HELP, the rates sentence and a policy link.
          text("VANTA LABS · TEXT MESSAGES", "footnote"),
          text("Restock texts, if you want them.", "heading_medium"),
          text("Optional. Cart reminders, restocks and subscriber offers by text.", "paragraph"),
          { type: "phoneNumberField", phoneNumberField: { label: "", placeholder: "Mobile number", defaultCountryCode: "US", countryCodes: { includes: ["US", "CA"] }, isRequired: false, requiredMessage: "A mobile number is required to receive texts", errorMessage: "That does not look like a mobile number" }, styleProperties: field },
          { type: "legal", legal: { type: "tcpa", label: "I agree to receive text messages from Vanta Labs", description: SMS_CONSENT, link: PRIVACY_URL, requiredMessage: "Tick the box to receive texts" }, styleProperties: { ...pad("4px", "0px", "8px"), fontSize: "11px", color: PALETTE.subtle } },
          text(`Consent is stored with your number. ${legalLink(PRIVACY_URL, "Privacy Policy")} · ${legalLink(TERMS_URL, "Terms")}`, "footnote", { padding: pad("0px", "0px", "8px") }),
          button("Add texts", "submit"),
          button("Skip this step", "nextStep", "secondary_button"),
        ]),
      ],
      successStep: step([
        text("You are on the list.", "heading_medium"),
        text("Your welcome offer arrives by email within two days. The catalogue and the COA library are open to account holders.", "paragraph"),
        button("Browse the catalogue", "link", "primary_button", { link: `${SITE}/products?utm_source=omnisend&utm_medium=form&utm_campaign=signup` }),
      ]),
      subscribedStep: step([
        text("You are already subscribed.", "heading_medium"),
        text("Batch reports and restocks will keep arriving. Questions? support@vantalabsresearch.com", "paragraph"),
      ]),
    },
  };
}
