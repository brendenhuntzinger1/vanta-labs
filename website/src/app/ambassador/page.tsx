import { notFound } from "next/navigation";

export default function AmbassadorPage() {
  // Public ambassador signup is intentionally disabled for now.
  // The ambassador/referral system remains in the codebase and admin flows.
  notFound();
}
