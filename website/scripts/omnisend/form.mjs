import { FONTS, PALETTE, SITE, hexId } from "./lib.mjs";

/**
 * The sign-up popup (spec §8): email first, an optional second step for SMS
 * with the store's own TCPA sentence, and a success screen naming the welcome
 * code. Restyled from Omnisend's email-and-SMS two-step template to the site
 * palette. Created DISABLED; the owner enables it after review.
 */

const p = (html, align = "left") => `<p style="margin:0;text-align:${align};">${html}</p>`;

function text(seed, html, preset, { align = "left", padding = "0px 0px 12px" } = {}) {
  return { id: hexId(seed), type: "text", text: p(html, align), stylePresetId: preset, styleProperties: { padding, alignment: align } };
}

function button(seed, label, type, preset = "primary_button") {
  return { id: hexId(seed), type: "button", button: { text: label.toUpperCase(), link: "", type, isFullWidth: true }, stylePresetId: preset, styleProperties: { padding: "8px 0px 0px" } };
}

function step(seed, blocks, padding = "36px 32px 36px") {
  return { sections: [{ id: hexId(`${seed}:section`), styleProperties: { backgroundColor: PALETTE.surface, opacity: 1, paddingTop: padding.split(" ")[0], paddingRight: padding.split(" ")[1], paddingBottom: padding.split(" ")[2], paddingLeft: padding.split(" ")[1] }, rows: [{ id: hexId(`${seed}:row`), columns: [{ id: hexId(`${seed}:col`), width: "100%", blocks }] }] }] };
}

const SMS_CONSENT = "Yes, I would like to receive recurring automated marketing text messages from Vanta Labs at the number above. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to cancel at any time or HELP for help.";

export function form() {
  const base = { fontFamily: FONTS.body, fontSize: "13px", fontWeight: "bold", letterSpacing: "1px", paddingLeft: "24px", paddingRight: "24px", paddingTop: "14px", paddingBottom: "14px", borderRadius: "14px" };
  return {
    name: "VL · Sign-up (email + SMS)",
    displayType: "popup",
    contactTags: ["form_subscriber", "source: omnisend-form"],
    clickOutside: { isEnabled: true },
    recaptcha: { isEnabled: true },
    targeting: {
      device: { desktop: true, mobile: true },
      display: { afterSeconds: 12, isExitIntentEnabled: true },
      frequency: { type: "day", value: 7 },
      source: { excludes: ["omnisendCommunication"] },
      location: { includes: ["US", "CA"] },
    },
    content: {
      generalSettings: {
        content: { color: PALETTE.foreground, width: "440px" },
        body: { backgroundColor: PALETTE.surface, borderRadius: "16px" },
        position: "middleCenter",
        closeButton: { backgroundColor: "", color: PALETTE.muted },
        link: { color: PALETTE.gold },
        fieldStyles: {
          errorColor: "#f09ca8",
          fontFamily: FONTS.body,
          fontSize: "15px",
          field: { backgroundColor: PALETTE.background, borderColor: "rgba(255,255,255,0.16)", borderRadius: "12px", borderStyle: "solid", borderWidth: "1px", color: PALETTE.foreground, paddingTop: "14px", paddingBottom: "14px", paddingLeft: "16px", paddingRight: "16px" },
          label: { color: PALETTE.muted, paddingTop: "8px", paddingBottom: "8px", paddingLeft: "0px", paddingRight: "0px" },
          placeholder: { color: PALETTE.subtle },
        },
        buttonPresets: [
          { id: "primary_button", name: "Primary", styles: { ...base, backgroundColor: PALETTE.surfaceRaised, border: `1px solid ${PALETTE.goldHairline}`, color: PALETTE.buttonText } },
          { id: "secondary_button", name: "Secondary", styles: { ...base, backgroundColor: "transparent", border: `1px solid ${PALETTE.hairlineStrong}`, color: PALETTE.foreground } },
          { id: "tertiary_button", name: "Tertiary", styles: { ...base, backgroundColor: "transparent", border: "0px solid transparent", color: PALETTE.gold, textDecoration: "underline" } },
        ],
        textPresets: [
          { id: "heading_large", name: "Heading Large", styles: { fontFamily: FONTS.display, fontSize: "30px", color: PALETTE.foreground, lineHeight: "120%", letterSpacing: "0px" } },
          { id: "heading_medium", name: "Heading Medium", styles: { fontFamily: FONTS.display, fontSize: "24px", color: PALETTE.foreground, lineHeight: "125%", letterSpacing: "0px" } },
          { id: "heading_small", name: "Heading Small", styles: { fontFamily: FONTS.display, fontSize: "19px", color: PALETTE.foreground, lineHeight: "130%", letterSpacing: "0px" } },
          { id: "paragraph", name: "Paragraph", styles: { fontFamily: FONTS.body, fontSize: "15px", color: PALETTE.body, lineHeight: "155%", letterSpacing: "0px" } },
          { id: "footnote", name: "Footnote", styles: { fontFamily: FONTS.body, fontSize: "11px", color: PALETTE.subtle, lineHeight: "150%", letterSpacing: "0px" } },
        ],
      },
      steps: [
        step("form:step1", [
          text("form:step1:eyebrow", "VANTA LABS", "footnote"),
          text("form:step1:heading", "Batch reports, restocks and subscriber offers.", "heading_medium"),
          text("form:step1:lead", "One or two emails a month. Every one links to the report for the batch it is about. Your welcome code arrives with the first.", "paragraph"),
          { id: hexId("form:step1:email"), type: "emailField", emailField: { label: "", placeholder: "Email address", isRequired: true, requiredMessage: "An email address is required", errorMessage: "That does not look like an email address" } },
          button("form:step1:submit", "Subscribe", "submit"),
          text("form:step1:footnote", "For laboratory research use only. Not for human or veterinary use. Unsubscribe at any time.", "footnote", { padding: "12px 0px 0px" }),
        ]),
        step("form:step2", [
          text("form:step2:eyebrow", "TEXT MESSAGES", "footnote"),
          text("form:step2:heading", "Restock texts, if you want them.", "heading_medium"),
          text("form:step2:lead", "Optional. Restocks and subscriber offers by text, a few times a month at most.", "paragraph"),
          { id: hexId("form:step2:phone"), type: "phoneNumberField", phoneNumberField: { label: "", placeholder: "Mobile number", defaultCountryCode: "US", isRequired: false, requiredMessage: "A mobile number is required to receive texts", errorMessage: "That does not look like a mobile number" } },
          { id: hexId("form:step2:legal"), type: "legal", legal: { description: SMS_CONSENT, isRequired: true, requiredMessage: "Tick the box to receive texts" } },
          button("form:step2:submit", "Add texts", "submit"),
          button("form:step2:skip", "Skip this step", "nextStep", "secondary_button"),
        ]),
      ],
      successStep: step("form:success", [
        text("form:success:heading", "You are on the list.", "heading_medium"),
        text("form:success:lead", "Your welcome code is on its way by email. The catalogue and the COA library are open to account holders.", "paragraph"),
        { id: hexId("form:success:link"), type: "button", button: { text: "BROWSE THE CATALOGUE", link: `${SITE}/products?utm_source=omnisend&utm_medium=form&utm_campaign=signup`, type: "link", isFullWidth: true }, stylePresetId: "primary_button", styleProperties: { padding: "8px 0px 0px" } },
      ]),
      subscribedStep: step("form:subscribed", [
        text("form:subscribed:heading", "You are already subscribed.", "heading_medium"),
        text("form:subscribed:lead", "Batch reports and restocks will keep arriving. Questions? support@vantalabsresearch.com", "paragraph"),
      ]),
    },
  };
}
