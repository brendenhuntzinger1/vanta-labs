"use client";

import { useState } from "react";
import type { PolicyContent } from "@/lib/legal-content";

function PolicyEditor({ policy }: { policy: PolicyContent }) {
  const [title, setTitle] = useState(policy.title);
  const [body, setBody] = useState(policy.body);
  const [updated, setUpdated] = useState(policy.updated);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: [{ section: "legal", key: policy.slug, value: { title, body, updated } }] }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      setMessage(json.success ? "Saved. Live on the site." : json.error ?? "Save failed");
    } catch {
      setMessage("Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="vl-panel rounded-2xl p-5">
      <summary className="cursor-pointer text-lg font-semibold">
        {policy.title} <span className="text-xs font-normal text-zinc-500">/legal/{policy.slug}</span>
      </summary>
      <div className="mt-4 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className="text-xs text-zinc-400">Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-zinc-400">Last updated
            <input value={updated} onChange={(e) => setUpdated(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
        </div>
        <label className="text-xs text-zinc-400">Body
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="vl-input mt-1 w-full px-3 py-2 font-mono text-xs leading-5" />
          <span className="mt-1 block text-[11px] text-zinc-500">Formatting: start a line with <code>## </code> for a heading; leave a blank line between paragraphs.</span>
        </label>
        <div className="flex items-center gap-3">
          <button type="button" disabled={saving} onClick={save} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50">{saving ? "Saving…" : "Save policy"}</button>
          {message ? <span className="text-xs text-zinc-300">{message}</span> : null}
        </div>
      </div>
    </details>
  );
}

export function AdminPoliciesClient({ policies }: { policies: PolicyContent[] }) {
  return (
    <div className="mt-6 space-y-3">
      {policies.map((policy) => (
        <PolicyEditor key={policy.slug} policy={policy} />
      ))}
    </div>
  );
}
