import { useEffect } from "react";

/**
 * Close a modal/overlay/drawer/popover when the user presses Escape.
 * Registers on document capture phase and calls preventDefault so the
 * topmost open overlay wins (LIFO) and lower handlers skip.
 */
export function useEscapeClose(isOpen: boolean, close: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen, close]);
}