import type { JSX } from "react";

/** Inline failed-fetch state for list panels, so a load error never reads as "empty". */
export function LoadErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 py-8 border border-dashed border-[#fb2c36]/40 rounded-lg bg-[#fb2c36]/5 text-center px-4"
    >
      <p className="text-xs text-[#b91c1c] break-words">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs font-semibold text-[#1c1cc8] border border-[#0000a8]/40 bg-[#0000a8]/10 hover:bg-[#0000a8]/20 rounded-md px-3 py-1.5 touch:min-h-11 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
