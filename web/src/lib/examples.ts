import type { TickerEvent } from "../components/Ticker";

/**
 * Example activity for the landing page. These are illustrations of how a
 * clause moves, labelled as examples wherever they appear; they are not
 * live figures.
 */
export const EXAMPLE_EVENTS: TickerEvent[] = [
  { account: "r-104", status: "released", amount: "2.00", asset: "USDC", note: "30 second cut delivered" },
  { account: "r-105", status: "funded", amount: "12.50", asset: "USDC", note: "from USDC on Base" },
  { account: "r-106", status: "delivered", amount: "40.00", asset: "USDT", note: "landing page copy" },
  { account: "r-107", status: "returned", amount: "8.00", asset: "USDC", note: "deadline passed, back to buyer" },
  { account: "r-108", status: "open", amount: "5.00", asset: "USDC", note: "agent hired a translator" },
  { account: "r-109", status: "refused", amount: "300.00", asset: "USDC", note: "over the payee ceiling" },
  { account: "r-110", status: "released", amount: "18.00", asset: "USDC", note: "API audit report" },
  { account: "r-111", status: "funded", amount: "3.25", asset: "USDC", note: "from ETH on Arbitrum" },
];

export const LIFECYCLE: Array<{ status: "open" | "funded" | "delivered" | "released"; title: string; detail: string }> = [
  { status: "open", title: "Clause written", detail: "r-104.clausehold.near created with one function-call key" },
  { status: "funded", title: "Funded through Intents", detail: "2.00 USDC arrived from USDC on Base" },
  { status: "delivered", title: "Delivery submitted", detail: "Signed by the editor's passkey. No gas paid." },
  { status: "released", title: "Released to editor.near", detail: "Receipt published. The buyer cannot pull it back." },
];
