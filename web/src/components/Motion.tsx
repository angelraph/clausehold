import { useEffect, useRef, useState, type ReactNode } from "react";

/** Fades a block in the first time it scrolls into view. */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${inView ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const DIGITS = "0123456789";

/** A number whose digits roll into place, like an odometer. */
export function Roll({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={`mono ${className}`} aria-label={value}>
      {value.split("").map((ch, i) =>
        DIGITS.includes(ch) ? (
          <span className="roll" key={i} aria-hidden="true">
            <span className="roll-col" style={{ transform: `translateY(-${Number(ch)}em)` }}>
              {DIGITS.split("").map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} aria-hidden="true">
            {ch}
          </span>
        )
      )}
    </span>
  );
}

/** Calls `fn` every `ms` while the tab is visible. */
export function useInterval(fn: () => void, ms: number) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") saved.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function formatUsd(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
