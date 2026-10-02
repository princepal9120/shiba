/**
 * ToneChip — the small status pill shared by the Integrations / Settings /
 * Analytics surfaces. Same palette as AgentsView's CHIP_TONES (that map is
 * private to AgentsView; this is the reusable component form).
 */
import type { JSX } from "react";

const TONE_CLASSES = {
  ok: "border-[#15803d]/30 bg-[#15803d]/10 text-[#15803d]",
  danger: "border-[#fb2c36]/30 bg-[#fb2c36]/10 text-[#fb2c36]",
  pending: "border-[#f99c00]/30 bg-[#f99c00]/10 text-[#b45309]",
  navy: "border-[#0000a8]/30 bg-[#0000a8]/10 text-[#1c1cc8]",
  neutral: "border-[#d3d2c8] bg-[#e0ded5]/60 text-[#6a6f63]",
} as const;

const TONE_DOTS = {
  ok: "bg-[#15803d]",
  danger: "bg-[#fb2c36]",
  pending: "bg-[#f99c00]",
  navy: "bg-[#0000a8]",
  neutral: "bg-[#6a6f63]",
} as const;

export type ChipTone = keyof typeof TONE_CLASSES;

export function ToneChip({ tone, label }: { tone: ChipTone; label: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-none border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${TONE_DOTS[tone]}`} />
      {label}
    </span>
  );
}
