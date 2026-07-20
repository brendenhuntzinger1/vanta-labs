import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Vanta Labs collects, uses, and protects your information.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="2026">
      <p>
        This policy explains what information we collect, how we use it, and the choices you have. By using this website
        you agree to the practices described here.
      </p>
      <h2>Information we collect</h2>
      <p>
        We collect information you provide at checkout and when contacting us — such as your name, email, shipping
        address, and order details — and limited technical data (such as device and usage analytics) to operate and
        improve the site.
      </p>
      <h2>How we use it</h2>
      <p>
        We use your information to process and fulfill orders, verify payments, provide customer support, send
        transactional messages, prevent fraud, and comply with legal obligations. We do not sell your personal
        information.
      </p>
      <h2>Sharing</h2>
      <p>
        We share information only with service providers that help us operate — for example, payment, email, hosting,
        and fulfillment providers — and only as needed to deliver our services or as required by law.
      </p>
      <h2>Data retention &amp; security</h2>
      <p>
        We retain order records as required for accounting and legal purposes, and we use reasonable administrative and
        technical safeguards to protect your information.
      </p>
      <h2>Your choices</h2>
      <p>
        You may request access to, correction of, or deletion of your personal information, and you can unsubscribe from
        marketing emails at any time. Contact <a href="mailto:support@vantalabsresearch.com">support@vantalabsresearch.com</a>.
      </p>
    </LegalPage>
  );
}
