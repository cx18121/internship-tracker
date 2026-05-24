"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Shared chip-input control for the include/exclude keyword filters that
// appear in both the FilterRail (advanced section) and the NotifModal
// (notification gates). Before this both surfaces carried near-identical
// inline copies of the input + add-button + chip-row + amber-dim-unknowns
// pattern; behavior drift between them was a real risk.
//
// Input state is owned internally — consumers only manage the committed
// `values` array. Enter or the Add button promotes the input into a chip;
// duplicates and whitespace-only entries are silently ignored.
//
// `tone` controls only the chip colour palette ("include" = neutral white,
// "exclude" = red). Keywords absent from `knownKeywords` get an amber/dim
// strikethrough with a tooltip explaining the empty-result implication —
// the gates compare against the scorer's tag set, not free text, so an
// unknown keyword silently wipes out all matches.

interface Props {
  values: string[];
  onValuesChange: (next: string[]) => void;
  placeholder: string;
  knownKeywords: Set<string>;
  tone: "include" | "exclude";
}

const ACTIVE_STYLES = {
  include: "bg-white/10 text-white/70",
  exclude: "bg-red-500/10 text-red-400",
} as const;

const DIM_STYLES = {
  include: "bg-amber-500/10 text-amber-400/80 line-through decoration-amber-400/50",
  exclude: "bg-white/[0.04] text-white/30 line-through decoration-white/20",
} as const;

const UNKNOWN_TOOLTIP = {
  include: "Not in any posting's tags — filter will return 0 results",
  exclude: "Not in any posting's tags — has no effect on results",
} as const;

export function KeywordChips({ values, onValuesChange, placeholder, knownKeywords, tone }: Props) {
  const [input, setInput] = useState("");

  function add(): void {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!values.includes(trimmed)) onValuesChange([...values, trimmed]);
    setInput("");
  }

  function remove(k: string): void {
    onValuesChange(values.filter((x) => x !== k));
  }

  return (
    <>
      <div className="flex gap-1.5">
        <Input
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          className="h-7 text-[12px] bg-white/[0.04] border-white/10"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] border-white/10 bg-white/[0.04]"
          onClick={add}
        >
          Add
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {values.map((k) => {
            const unknown = !knownKeywords.has(k.toLowerCase());
            return (
              <span
                key={k}
                title={unknown ? UNKNOWN_TOOLTIP[tone] : undefined}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                  unknown ? DIM_STYLES[tone] : ACTIVE_STYLES[tone]
                }`}
              >
                {k}
                <button onClick={() => remove(k)}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
