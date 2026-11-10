import { config } from "../config.js";
import { viewCall } from "./rpc.js";

export interface RoleStats {
  open: number;
  released: number;
  returned: number;
  released_volume: string;
}

export interface Standing {
  as_payee: RoleStats;
  as_buyer: RoleStats;
}

/** The factory's record of an account: clauses it was paid through and clauses it paid for. */
export function readStanding(accountId: string): Promise<Standing> {
  return viewCall<Standing>(config.factoryAccountId, "standing", { account_id: accountId });
}

/**
 * How many clauses this payee has been paid through, from the chain. Null when
 * the chain does not answer in time, so a slow RPC never blocks a clause check.
 */
export async function chainReleases(payee: string, timeoutMs = 2500): Promise<number | null> {
  if (!config.chainStanding) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const s = await Promise.race([readStanding(payee), timeout]);
    return s ? s.as_payee.released : null;
  } catch {
    return null;
  }
}
