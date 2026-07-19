"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export function PartnerLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError || !data.session?.access_token || !data.user) {
        throw new Error(signInError?.message ?? "Unable to sign in");
      }

      const sessionResponse = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: data.session.access_token }),
      });
      const sessionJson = await sessionResponse.json();

      if (!sessionResponse.ok || !sessionJson.success) {
        throw new Error(sessionJson.error ?? "Unable to establish session");
      }

      const role = String(sessionJson.user?.role ?? "").toLowerCase();
      if (role === "admin") {
        router.push("/admin/partners");
      } else {
        router.push("/partner/dashboard");
      }
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 sm:p-8">
      <p className="text-[11px] uppercase tracking-[0.35em] text-zinc-300">Partner Portal</p>
      <h1 className="mt-3 text-3xl font-semibold text-white">Secure Login</h1>
      <p className="mt-2 text-sm text-zinc-400">Use your approved partner credentials to access real-time commissions and referral performance.</p>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-zinc-400">
          <span className="mb-2 block">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="vl-input w-full px-4 py-3"
            autoComplete="email"
            required
          />
        </label>

        <label className="block text-sm text-zinc-400">
          <span className="mb-2 block">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="vl-input w-full px-4 py-3"
            autoComplete="current-password"
            required
          />
        </label>
      </div>

      {error ? <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Signing in..." : "Sign In"}
      </button>
    </form>
  );
}
