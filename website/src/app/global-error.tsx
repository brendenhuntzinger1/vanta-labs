"use client";

// Catches a crash in the ROOT layout itself (which the per-page error.tsx
// cannot). It must render its own <html>/<body>. Kept intentionally minimal
// and dependency-free so it works even when the app shell is broken.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0b0b", color: "#f4f4f4", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "24px" }}>
          <p style={{ letterSpacing: "0.3em", textTransform: "uppercase", fontSize: "12px", color: "#a1a1aa", margin: 0 }}>Vanta Labs</p>
          <h1 style={{ fontSize: "28px", margin: "16px 0 8px" }}>Something went wrong</h1>
          <p style={{ color: "#a1a1aa", maxWidth: "28rem", lineHeight: 1.6 }}>
            We hit an unexpected error. Please try again — if it keeps happening, refresh the page.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: "24px", padding: "12px 24px", borderRadius: "999px", border: "1px solid #fff", background: "#fff", color: "#0b0b0b", fontWeight: 700, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
