import { Command } from "cmdk";
import type { JSX, ReactNode } from "react";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// cmdk has no Dialog wrapper; this is the app-level command dialog surface.
function CommandDialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] p-4">
      <button
        type="button"
        aria-label="Close command menu"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="relative bg-[#fffef8] border border-[#eae8e1] rounded-xl max-w-md w-full shadow-2xl overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

export function CommandMenu({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}): JSX.Element | null {
  return (
    <CommandDialog open={open} onClose={onClose}>
      <Command label="Command menu">
        <Command.Input
          autoFocus
          placeholder="Type a command or search…"
          className="w-full bg-transparent px-4 py-3 text-sm text-[#222320] placeholder:text-[#6a6f63] border-b border-[#eae8e1] focus:outline-none"
        />
        <Command.List className="max-h-72 overflow-y-auto py-1.5">
          <Command.Empty className="px-4 py-6 text-center text-xs text-[#6a6f63]">
            No matching commands.
          </Command.Empty>
          {commands.map((item) => (
            <Command.Item
              key={item.id}
              value={item.label}
              onSelect={() => {
                onClose();
                item.run();
              }}
              className="w-full flex items-center justify-between px-4 py-2 text-left text-sm text-[#6a6f63] cursor-pointer data-[selected=true]:bg-[#0000a8]/15 data-[selected=true]:text-[#222320]"
            >
              <span>{item.label}</span>
              {item.hint ? (
                <span className="font-mono text-[10px] text-[#6a6f63]">
                  {item.hint}
                </span>
              ) : null}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </CommandDialog>
  );
}
