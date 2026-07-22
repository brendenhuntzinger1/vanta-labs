"use client";

// Small client-side button that triggers the browser's print dialog. Used on
// the printable COA label page so the owner can print a batch label in one
// click. Hidden from the printout itself via `print:hidden`.
export function PrintButton({
  label = "Print label",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={`print:hidden rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-black/80 ${className}`}
    >
      {label}
    </button>
  );
}
