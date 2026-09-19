import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { SmsOptInForm } from "@/components/sms-optin-form";
import { getBusinessSettings } from "@/lib/admin-control";
import { BRAND_LEGAL_NAME, BRAND_SHORT_NAME } from "@/lib/site-identity";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  path: "/sms",
  title: "SMS Marketing Sign-Up",
  description:
    "Sign up to receive promotional text messages from Vanta Labs. Consent is not a condition of purchase, and you can reply STOP at any time.",
});

/**
 * THE PUBLIC SMS OPT-IN.
 *
 * WHY IT EXISTS AS ITS OWN PAGE. This store's toll-free number was refused
 * verification repeatedly, and the consent wording — which is the thing that
 * kept being rewritten between attempts — was never what was wrong with it.
 * The wall was. Every copy of the opt-in form renders on /products,
 * /products/[slug] or /cart, all of which require an account, so the one
 * artefact the review is about was the one artefact a reviewer could not
 * reach. A carrier cannot approve a consent flow it is served a sign-in page
 * for.
 *
 * SO IT IS DELIBERATELY BORING, AND PERMANENT. Not a reviewer mode, not a
 * temporary page taken down after approval, and emphatically not a different
 * response for a user-agent that looks like a reviewer — that last one is
 * cloaking, and this repository rejects it everywhere else for the same
 * reason. One page, one answer, for a carrier and a customer alike. Numbers
 * get re-reviewed, and a complaint re-opens the file; a page that only existed
 * during the submission window would fail exactly then.
 *
 * WHAT A REVIEWER HAS TO SEE WITHOUT SCROLLING PAST DECORATION, and therefore
 * what is laid out above the fold on a normal desktop viewport: who is
 * sending, what is being consented to, that it is marketing and only
 * marketing, an unticked box, the full TCPA sentence at a size a person can
 * actually read, STOP and HELP, and both policy links.
 *
 * WHAT IT DOES NOT DO:
 *
 *   * advertise a discount. The welcome incentive is not offered here, so
 *     nobody ticks this box in exchange for a code, and the screenshot carries
 *     no promotional claim a reviewer has to assess;
 *   * collect one consent and imply another. The 21+ statement and the SMS
 *     agreement are separate boxes, separately unticked, and neither one
 *     checks the other;
 *   * compete with the acquisition funnel. It opens on its own URL, never as a
 *     pop-up, and nothing routes a shopper into it.
 */
export default async function SmsOptInPage() {
  // The address the store actually answers on, not a constant that drifts from
  // it: the owner can change it in Admin → Settings, and a support address on
  // a compliance page that bounces is worse than no address at all.
  const { supportEmail } = await getBusinessSettings();

  return (
    <div className="vl-auth-shell relative min-h-screen overflow-hidden text-white">
      <main className="relative mx-auto flex w-full max-w-2xl flex-col px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
        <header>
          <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.34em] text-white">
            {BRAND_SHORT_NAME}
          </p>
          <p className="mt-1.5 text-[10px] uppercase tracking-[0.3em] text-[color:var(--accent-gold)]/75">
            Research Peptides
          </p>
        </header>

        <h1 className="vl2-serif mt-8 text-[1.875rem] leading-[1.14] tracking-[-0.015em] text-white sm:text-[2.25rem]">
          SMS Marketing Sign-Up
        </h1>
        <p className="vl-optin-lede mt-4">
          Sign up to receive promotional text messages from {BRAND_SHORT_NAME}.
        </p>

        {/* WHO IS ASKING. A reviewer has to be able to tell that this is a real,
            identifiable business from the page itself, not by cross-referencing
            a WHOIS record. Only what the site already publishes: the entity name
            and the support address that is in the footer of every public URL.
            Nothing is invented here — see the note in lib/site-identity.ts about
            why no postal address or telephone number is asserted anywhere. */}
        <p className="vl-optin-identity mt-3">
          Operated by {BRAND_LEGAL_NAME} ·{" "}
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
        </p>

        <SmsOptInForm />

        {/* THE PROGRAMME, STATED SEPARATELY FROM THE AGREEMENT ABOVE IT.
            Marketing only. Order and shipping notifications are a different
            legal basis and are not bundled into this consent — saying "updates
            and offers" in one sentence is one of the named rejection reasons,
            and it is also just untrue of what this box does. */}
        <section className="vl-optin-panel mt-10">
          <h2 className="vl-optin-panel-title">About this programme</h2>
          <dl className="vl-optin-facts">
            <div>
              <dt>Programme</dt>
              <dd>{BRAND_SHORT_NAME} promotional and marketing text messages.</dd>
            </div>
            <div>
              <dt>Message frequency</dt>
              <dd>Varies. Recurring automated marketing messages.</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>Message and data rates may apply. We charge nothing to subscribe.</dd>
            </div>
            <div>
              <dt>To stop</dt>
              <dd>Reply STOP to any message to cancel. Reply HELP for help.</dd>
            </div>
            <div>
              <dt>Help</dt>
              <dd>
                <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
              </dd>
            </div>
            <div>
              <dt>Your number</dt>
              <dd>
                Never sold, and never shared with third parties or affiliates for their own
                marketing.
              </dd>
            </div>
          </dl>
        </section>

        {/* THE AGE RESTRICTION, AND HOW IT IS ACTUALLY ENFORCED.
            Said plainly rather than implied, because a reviewer asking "does
            this site have an age gate" deserves a straight answer, and because
            the honest answer here is stronger than the usual one: the catalogue
            is not behind a dismissible overlay, it is behind an account, and
            the 21+ representation is taken before that account exists. An
            overlay that renders the storefront and covers it with CSS is what
            this store used to have, and it protected nothing. */}
        <section className="vl-optin-panel mt-6">
          <h2 className="vl-optin-panel-title">Age restriction</h2>
          <p className="vl-optin-panel-body">
            {BRAND_LEGAL_NAME} supplies materials strictly for laboratory research use, and
            this site is restricted to adults aged 21 or over. The product catalogue is not
            public: it requires an account, and creating one requires an explicit confirmation
            that you are 21 or older and that any materials purchased are for laboratory
            research only. The confirmation above applies to this sign-up form.
          </p>
        </section>

        <p className="vl-optin-footnote mt-10">For laboratory research use only.</p>
      </main>
    </div>
  );
}
