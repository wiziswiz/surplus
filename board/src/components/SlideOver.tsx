import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Keep Tab cycling inside `root` (dialog focus trap). */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = root.querySelectorAll<HTMLElement>(FOCUSABLE);
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Right-edge slide-over dialog: overlay fade + panel slide (300ms ease-out in,
 * 200ms ease-in out), focus trap, Escape/overlay-click to close, focus restore.
 * Children receive `close` so inner buttons exit through the same choreography.
 */
export function SlideOver({
  label,
  onClose,
  widthClass = 'w-md',
  children,
}: {
  label: string;
  onClose: () => void;
  widthClass?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const close = useCallback(() => {
    setClosing(true);
    if (closeTimer.current === null) {
      closeTimer.current = window.setTimeout(onClose, 200);
    }
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        trapTab(e, panelRef.current);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      previouslyFocused?.focus();
    };
  }, [close]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={close}
        className={`fixed inset-0 z-(--z-modal) bg-black/40 ${closing ? 'overlay-exit' : 'overlay-enter'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`fixed inset-y-0 right-0 z-(--z-modal) flex ${widthClass} max-w-full flex-col overflow-y-auto bg-raised shadow-xl outline-none ${
          closing ? 'drawer-exit' : 'drawer-enter'
        }`}
      >
        {children(close)}
      </div>
    </>
  );
}
