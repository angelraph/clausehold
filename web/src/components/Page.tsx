import type { ReactNode } from "react";

export function PageHead({ eyebrow, title, soft, children }: { eyebrow?: string; title: string; soft?: string; children?: ReactNode }) {
  return (
    <div className="wrap page-head">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1 className="h2 two-tone" style={{ marginTop: eyebrow ? 14 : 0, maxWidth: 900 }}>
        {title} {soft && <span className="soft">{soft}</span>}
      </h1>
      {children && <div style={{ marginTop: 18 }}>{children}</div>}
    </div>
  );
}

export function ApiDown({ message }: { message: string }) {
  return (
    <div className="notice" role="status">
      <span>
        {message} {location.hostname === "localhost" || location.hostname === "127.0.0.1" ? <>Run <code className="mono">npm run dev -- serve</code> from the repository, or set the API address in Desk settings.</> : "Try again in a moment."}
      </span>
    </div>
  );
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}
