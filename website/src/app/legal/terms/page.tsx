import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms governing your use of the Vanta Labs website and purchases.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="2026">
      <p>
        These terms govern your use of this website and any purchase you make. By using the site or placing an order,
        you agree to these terms.
      </p>
      <h2>Eligibility &amp; acceptable use</h2>
      <p>
        You must be at least 21 years old and legally permitted to purchase laboratory research materials in your
        jurisdiction. You agree to use the site lawfully and to provide accurate information at checkout.
      </p>
      <h2>Research use only</h2>
      <p>
        All products are sold strictly for laboratory research use and are not for human or animal consumption. See our{" "}
        <a href="/legal/research-disclaimer">Research Disclaimer</a> for details.
      </p>
      <h2>Orders, pricing &amp; payment</h2>
      <p>
        We may accept or decline any order. Prices, fees, and availability may change without notice. Manual payment
        methods are verified before an order is fulfilled; a card processing fee, where shown, is disclosed before you
        submit payment.
      </p>
      <h2>Shipping &amp; fulfillment</h2>
      <p>
        Orders ship after payment is verified. Delivery times are estimates and are not guaranteed. Risk of loss passes
        to you on delivery to the carrier.
      </p>
      <h2>Returns &amp; refunds</h2>
      <p>
        Because of the nature of these materials, returns may be limited. Refund eligibility and process are handled
        case by case — contact support for assistance.
      </p>
      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, the seller is not liable for any indirect, incidental, or consequential
        damages arising from the use or misuse of any product.
      </p>
      <h2>Contact</h2>
      <p><a href="mailto:brendenhuntzinger1@vantalabsresearch.com">brendenhuntzinger1@vantalabsresearch.com</a></p>
    </LegalPage>
  );
}
