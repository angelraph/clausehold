export type ClauseStatus = "awaiting" | "expired" | "open" | "funded" | "delivered" | "released" | "returned" | "frozen" | "refused";

const LABEL: Record<ClauseStatus, string> = {
  awaiting: "Waiting for key",
  expired: "Expired",
  open: "Open",
  funded: "Funded",
  delivered: "Delivered",
  released: "Released",
  returned: "Returned",
  frozen: "Frozen",
  refused: "Refused",
};

export function StatusChip({ status }: { status: ClauseStatus }) {
  return <span className={`chip chip-${status}`}>{LABEL[status]}</span>;
}
