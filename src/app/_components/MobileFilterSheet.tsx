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

  // ESC to close + body scroll lock + focus management while open.
  useEffect(() => {
    if (!open) return;

    // Stash the element that opened the sheet so we can restore focus on
    // close — keyboard + screen-reader users should land back on the trigger.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Trap tab focus within the sheet. Without this, tab can reach
      // elements behind the backdrop, defeating the modal contract.
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);

    // Move focus to the first focusable element INSIDE the sheet — not the
    // wrapping panel div. The trap's first/last math compares against
    // document.activeElement, and if the active element is the panel itself
    // (tabIndex=-1) it matches neither first nor last, so a Shift+Tab from
    // that state escapes the trap and lands behind the backdrop.
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    if (firstFocusable) firstFocusable.focus();
    else panelRef.current?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      // Restore focus to the trigger that opened the sheet.
      previouslyFocused?.focus?.();
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
