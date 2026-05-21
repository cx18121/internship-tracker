"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Left-anchored sheet that mounts the FilterRail on small viewports.
 * Closes on backdrop click or Escape. Locks body scroll while open.
 */
export function MobileFilterSheet({ open, onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // ESC to close + body scroll lock while open
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Focus the panel so screen readers + keyboard users land in the sheet.
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="lg:hidden fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-100"
      />
      {/* Sheet */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Filters"
        className="absolute inset-y-0 left-0 w-[88vw] max-w-[320px] bg-[oklch(0.10_0.005_260)] border-r border-white/10 shadow-[8px_0_24px_oklch(0_0_0_/_45%)] animate-in slide-in-from-left duration-150 outline-none"
      >
        {/* Close button floats over the FilterRail's own header — sheet
            doesn't need a duplicate "Filters" label since the rail provides one. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          className="absolute top-3 right-3 h-7 w-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors z-10"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="overflow-y-auto h-full px-4 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
