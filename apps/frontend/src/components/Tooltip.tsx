import {
  type ReactNode,
  type JSX,
  useState,
  useRef,
  useEffect,
  useId,
  useCallback,
  cloneElement,
  isValidElement,
} from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delayMs?: number;
  disabled?: boolean;
  className?: string;
}

interface Coords {
  top: number;
  left: number;
  transform: string;
}

export function Tooltip({
  content,
  children,
  shortcut,
  side = "top",
  align = "center",
  delayMs = 250,
  disabled = false,
  className = "",
}: TooltipProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || typeof window === "undefined") return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 6;
    let top = 0;
    let left = 0;
    let transform = "";

    switch (side) {
      case "top":
        top = rect.top - gap;
        if (align === "start") {
          left = rect.left;
          transform = "translate(0, -100%)";
        } else if (align === "end") {
          left = rect.right;
          transform = "translate(-100%, -100%)";
        } else {
          left = rect.left + rect.width / 2;
          transform = "translate(-50%, -100%)";
        }
        break;

      case "bottom":
        top = rect.bottom + gap;
        if (align === "start") {
          left = rect.left;
          transform = "translate(0, 0)";
        } else if (align === "end") {
          left = rect.right;
          transform = "translate(-100%, 0)";
        } else {
          left = rect.left + rect.width / 2;
          transform = "translate(-50%, 0)";
        }
        break;

      case "left":
        left = rect.left - gap;
        if (align === "start") {
          top = rect.top;
          transform = "translate(-100%, 0)";
        } else if (align === "end") {
          top = rect.bottom;
          transform = "translate(-100%, -100%)";
        } else {
          top = rect.top + rect.height / 2;
          transform = "translate(-100%, -50%)";
        }
        break;

      case "right":
        left = rect.right + gap;
        if (align === "start") {
          top = rect.top;
          transform = "translate(0, 0)";
        } else if (align === "end") {
          top = rect.bottom;
          transform = "translate(0, -100%)";
        } else {
          top = rect.top + rect.height / 2;
          transform = "translate(0, -50%)";
        }
        break;
    }

    setCoords({ top, left, transform });
  }, [side, align]);

  const show = useCallback(
    (immediate = false) => {
      if (disabled || !content) return;
      // Touch taps emit mouseenter/focus; a hover hint would then stick over the control.
      if (window.matchMedia?.("(hover: none)").matches) return;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      if (immediate || delayMs <= 0) {
        updatePosition();
        setIsOpen(true);
      } else {
        timerRef.current = window.setTimeout(() => {
          updatePosition();
          setIsOpen(true);
        }, delayMs);
      }
    },
    [disabled, content, delayMs, updatePosition],
  );

  const hide = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    const handleScrollOrResize = () => {
      updatePosition();
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen, hide, updatePosition]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  let triggerNode: ReactNode;

  if (isValidElement(children)) {
    const childProps = (children.props ?? {}) as Record<string, unknown>;
    triggerNode = cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node;
        const childRef = (children as { ref?: unknown }).ref;
        if (typeof childRef === "function") {
          childRef(node);
        } else if (childRef && typeof childRef === "object" && "current" in childRef) {
          (childRef as { current: unknown }).current = node;
        }
      },
      onMouseEnter: (e: React.MouseEvent) => {
        (childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
        show(false);
      },
      onMouseLeave: (e: React.MouseEvent) => {
        (childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
        hide();
      },
      onFocus: (e: React.FocusEvent) => {
        (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
        show(true);
      },
      onBlur: (e: React.FocusEvent) => {
        (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
        hide();
      },
      onClick: (e: React.MouseEvent) => {
        (childProps.onClick as ((e: React.MouseEvent) => void) | undefined)?.(e);
        hide();
      },
      "aria-describedby": isOpen ? tooltipId : childProps["aria-describedby"],
    });
  } else {
    triggerNode = (
      <span
        ref={(node) => {
          triggerRef.current = node;
        }}
        onMouseEnter={() => show(false)}
        onMouseLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
        className="inline-flex"
        aria-describedby={isOpen ? tooltipId : undefined}
      >
        {children}
      </span>
    );
  }

  const tooltipPortal =
    mounted && isOpen && coords && typeof document !== "undefined"
      ? createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            style={{
              position: "fixed",
              top: coords.top + "px",
              left: coords.left + "px",
              transform: coords.transform,
            }}
            className={
              "z-[9999] pointer-events-none select-none px-2.5 py-1 text-[11px] font-sans font-medium text-[#222320] bg-[#f1efe6]/95 border border-black/[0.14] rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.6)] backdrop-blur-md flex items-center gap-1.5 tracking-tight transition-opacity duration-150 animate-in fade-in zoom-in-95 " +
              className
            }
          >
            <span className="truncate">{content}</span>
            {shortcut ? (
              <kbd className="font-mono text-[9px] font-semibold text-[#6a6f63] bg-black/[0.08] border border-black/[0.1] px-1 py-0.5 rounded leading-none">
                {shortcut}
              </kbd>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {triggerNode}
      {tooltipPortal}
    </>
  );
}
