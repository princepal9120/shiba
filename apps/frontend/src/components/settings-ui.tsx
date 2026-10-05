/** Shared chrome for Settings surfaces — the bordered card every section composes. */
import type { JSX, ReactNode } from "react";

export function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
      {children}
    </div>
  );
}
