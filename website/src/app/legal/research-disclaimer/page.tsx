import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Research Disclaimer",
  description: "Products are sold strictly as laboratory research materials for research use only.",
};

export default function ResearchDisclaimerPage() {
  return (
    <LegalPage title="Research Disclaimer" updated="2026">
      <p>
        All products sold on this website are intended <strong>strictly for laboratory and research use only</strong>.
        They are not drugs, dietary supplements, food, cosmetics, or medical devices, and they are not intended to
        diagnose, treat, cure, or prevent any disease or condition.
      </p>
      <h2>Not for human or animal use</h2>
      <p>
        Products are not for human or veterinary consumption. No instructions for preparation, dosage, or administration
        are provided, and none should be inferred. The purchaser assumes full responsibility for the safe handling,
        storage, and lawful use of all materials.
      </p>
      <h2>Eligibility</h2>
      <p>
        By purchasing, you confirm that you are at least 21 years of age, that you are a qualified researcher or
        institution, and that you are legally permitted to purchase these materials in your jurisdiction.
      </p>
      <h2>No medical advice</h2>
      <p>
        Nothing on this website constitutes medical, scientific, or professional advice. The seller does not provide
        guidance on the use of research materials.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about this disclaimer can be sent to{" "}
        <a href="mailto:brendenhuntzinger1@vantalabsresearch.com">brendenhuntzinger1@vantalabsresearch.com</a>.
      </p>
    </LegalPage>
  );
}
