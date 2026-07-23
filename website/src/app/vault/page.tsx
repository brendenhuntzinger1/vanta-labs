"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function VaultPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passcode, setPasscode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/admin/auth/session", { cache: "no-store" });
        if (!cancelled && res.ok) {
          setIsAuthenticated(true);
        }
      } catch {
        // Ignore transient errors; user can still sign in manually.
      }
    };

    void check();

    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setStatus(null);

    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, passcode }),
      });

      const json = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !json.ok) {
        setStatus(json.error ?? "Unable to sign in.");
        return;
      }

      router.replace("/admin/partners");
    } catch {
      setStatus("Unable to sign in right now.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onLogout = async () => {
    setStatus(null);
    setIsSubmitting(true);

    try {
      await fetch("/api/admin/auth/logout", { method: "POST" });
      setIsAuthenticated(false);
      setStatus("Signed out.");
    } catch {
      setStatus("Unable to sign out right now.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-md">
        <div className="vl-panel rounded-[1.8rem] border border-white/15 p-6 sm:p-8">
          <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Access</p>
          <h1 className="mt-3 text-2xl font-semibold text-white">Secure Console</h1>
          <p className="mt-2 text-sm text-zinc-400">Restricted access only.</p>

          {isAuthenticated ? (
            <div className="mt-6 space-y-4">
              <p className="text-sm text-zinc-300">Session active.</p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => router.push("/admin/partners")}
                  className="vl-btn-primary vl-focus-ring px-4 py-2 text-sm"
                >
                  Open Admin
                </button>
                <button
                  type="button"
                  onClick={onLogout}
                  disabled={isSubmitting}
                  className="vl-btn-secondary vl-focus-ring px-4 py-2 text-sm"
                >
                  {isSubmitting ? "Signing out..." : "Sign out"}
                </button>
              </div>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={onSubmit} autoComplete="off">
              <label className="block text-xs uppercase tracking-[0.16em] text-zinc-500">
                Username
                <input
                  className="vl-input mt-2 w-full px-3 py-2"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                  required
                />
              </label>

              <label className="block text-xs uppercase tracking-[0.16em] text-zinc-500">
                Password
                <input
                  className="vl-input mt-2 w-full px-3 py-2"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="off"
                  required
                />
              </label>

              <label className="block text-xs uppercase tracking-[0.16em] text-zinc-500">
                6-Digit Passcode
                <input
                  className="vl-input mt-2 w-full px-3 py-2 tracking-[0.5em]"
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="••••••"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                />
              </label>

              <button
                type="submit"
                disabled={isSubmitting}
                className="vl-btn-primary vl-focus-ring w-full px-4 py-2 text-sm"
              >
                {isSubmitting ? "Entering..." : "Enter"}
              </button>
            </form>
          )}

          {status ? <p className="mt-4 text-sm text-zinc-300">{status}</p> : null}
        </div>
      </div>
    </div>
  );
}
