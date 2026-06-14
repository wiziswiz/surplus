import { useEffect, useId, useState } from 'react';

/**
 * A small circled-"i" button that reveals a plain-English tooltip on hover AND
 * keyboard focus. The tooltip is linked via aria-describedby, dismissed on
 * Escape/blur, and positioned below the trigger (flips above near the viewport
 * top). Reduced-motion safe — the fade is opacity-only and respects the global
 * reduced-motion block in index.css.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);

  const show = (el: HTMLElement) => {
    // Flip above when the trigger sits in the top ~140px of the viewport.
    setAbove(el.getBoundingClientRect().top < 140);
    setOpen(true);
  };

  // While the tooltip is open, intercept Escape before it reaches the Settings
  // SlideOver. SlideOver listens for Escape on `document` in the capture phase
  // and unconditionally closes the whole panel, so a bubble-phase React handler
  // here would never run. Listening on `window` in the capture phase fires
  // earlier in the dispatch path than `document`, letting us swallow Escape
  // (stopImmediatePropagation) and close only the tooltip.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={() => setOpen(false)}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-faint transition-colors duration-150 hover:text-ink"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute left-1/2 z-(--z-tooltip) w-64 max-w-[16rem] -translate-x-1/2 rounded-card bg-overlay px-3 py-2 text-xs leading-relaxed text-dim shadow-lg ring-1 ring-line ${
            above ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
