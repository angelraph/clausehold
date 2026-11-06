import { StatusChip, type ClauseStatus } from "./Status";

export interface TickerEvent {
  account: string;
  status: ClauseStatus;
  amount: string;
  asset: string;
  note: string;
}

/**
 * A strip of clause events sliding past. The list is drawn twice so the
 * loop is seamless; hovering pauses it, and reduced motion stops it.
 */
export function Ticker({ label, events }: { label: string; events: TickerEvent[] }) {
  const row = events.map((e, i) => (
    <div className="ticker-item" key={i}>
      <StatusChip status={e.status} />
      <span className="mono">{e.account}</span>
      <span className="mono" style={{ color: "var(--text)" }}>
        {e.amount} {e.asset}
      </span>
      <span className="faint">{e.note}</span>
    </div>
  ));
  return (
    <div className="ticker" role="marquee" aria-label={label}>
      <div className="ticker-label">
        <span className="pulse" />
        {label}
      </div>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div className="ticker-track">
          {row}
          {row}
        </div>
      </div>
    </div>
  );
}
