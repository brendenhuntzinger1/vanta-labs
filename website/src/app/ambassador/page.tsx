"use client";

import { FormEvent, useState } from "react";
import { SiteHeader } from "@/components/site-header";

import { supabase } from "@/lib/supabase";

function createReferralCode(name: string) {
const cleanName = name
.trim()
.toUpperCase()
.replace(/[^A-Z0-9]/g, "")
.slice(0, 12);

const randomNumber = Math.floor(100 + Math.random() * 900);

return `${cleanName || "VANTA"}${randomNumber}`;
}

export default function AmbassadorPage() {
const [name, setName] = useState("");
const [email, setEmail] = useState("");
const [referralCode, setReferralCode] = useState("");
const [message, setMessage] = useState("");
const [submitting, setSubmitting] = useState(false);

async function submitApplication(event: FormEvent<HTMLFormElement>) {
event.preventDefault();

setSubmitting(true);
setMessage("");

const finalReferralCode =
referralCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ||
createReferralCode(name);

const { error } = await supabase.from("ambassadors").insert({
name: name.trim(),
email: email.trim().toLowerCase(),
referral_code: finalReferralCode,
commission_percent: 10,
status: "pending",
});

if (error) {
if (error.code === "23505") {
setMessage(
"That email or referral code is already being used. Try another one.",
);
} else {
setMessage(`Application failed: ${error.message}`);
}

setSubmitting(false);
return;
}

setMessage(
"Application submitted. Vanta Labs must approve your account before your referral code becomes active.",
);

setName("");
setEmail("");
setReferralCode("");
setSubmitting(false);
}

return (
<>
<SiteHeader />

<main className="min-h-screen px-6 py-16">
<section className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8">
<p className="text-sm uppercase tracking-[0.25em] text-cyan-300">
Vanta Labs
</p>

<h1 className="mt-3 text-4xl font-semibold text-white">
Ambassador application
</h1>

<p className="mt-4 text-white/60">
Apply for a referral code. Applications must be approved before
the code becomes active.
</p>

<form onSubmit={submitApplication} className="mt-8 space-y-5">
<label className="block">
<span className="mb-2 block text-sm text-white/70">Name</span>

<input
value={name}
onChange={(event) => setName(event.target.value)}
required
className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none"
/>
</label>

<label className="block">
<span className="mb-2 block text-sm text-white/70">Email</span>

<input
type="email"
value={email}
onChange={(event) => setEmail(event.target.value)}
required
className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none"
/>
</label>

<label className="block">
<span className="mb-2 block text-sm text-white/70">
Requested referral code
</span>

<input
value={referralCode}
onChange={(event) => setReferralCode(event.target.value)}
placeholder="Example: BRENDEN10"
className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 uppercase text-white outline-none"
/>

<span className="mt-2 block text-xs text-white/40">
Leave blank and one will be generated automatically.
</span>
</label>

<button
type="submit"
disabled={submitting}
className="w-full rounded-xl bg-cyan-300 px-5 py-3 font-semibold text-black disabled:opacity-50"
>
{submitting ? "Submitting..." : "Submit application"}
</button>
</form>

{message && (
<p className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/80">
{message}
</p>
)}

<p className="mt-6 text-sm text-white/50">
Approved ambassadors earn 10% of eligible referred sales.
</p>
</section>
</main>
</>
);
}