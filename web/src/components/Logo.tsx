/**
 * The Clausehold mark, redrawn as a vector from the brand logo: a white C,
 * a violet ring around it, and a violet shield with a keyhole at the center.
 */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="ch-c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c9c6d6" />
        </linearGradient>
        <linearGradient id="ch-v" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6d28d9" />
          <stop offset="1" stopColor="#a874ff" />
        </linearGradient>
      </defs>
      <path d="M47 19.5a20 20 0 1 0 0 25" fill="none" stroke="url(#ch-c)" strokeWidth="8.5" strokeLinecap="round" />
      <ellipse cx="32" cy="33" rx="29" ry="9.5" transform="rotate(-22 32 33)" fill="none" stroke="url(#ch-v)" strokeWidth="3.4" />
      <path d="M32 21.5l8.5 3.3v6.7c0 5.4-3.6 9-8.5 10.9-4.9-1.9-8.5-5.5-8.5-10.9v-6.7z" fill="url(#ch-v)" />
      <circle cx="32" cy="29.8" r="2.5" fill="#07060b" />
      <path d="M30.7 31.4h2.6l1 5.4h-4.6z" fill="#07060b" />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <LogoMark size={size} />
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: size * 0.66, letterSpacing: "-0.02em" }}>
        Clause<span style={{ color: "var(--violet-2)" }}>hold</span>
      </span>
    </span>
  );
}
