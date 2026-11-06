import { Account, type KeyPairString } from "near-api-js";
import { config } from "../config.js";
import { FactoryClauseWriter } from "../near/factoryWriter.js";
import { OneClickClient } from "../near/intents.js";
import { networkProfile } from "../near/network.js";
import { relayDelivery } from "../near/relayer.js";
import { getProvider } from "../near/rpc.js";
import { callerFromAccount, readerFromProvider } from "../near/chain.js";
import type { ApiDeps } from "./server.js";

/**
 * Builds the API's outside connections from config. The service account
 * (CLAUSEHOLD_RELAYER_ACCOUNT and its key) signs two things: creating a
 * clause through the factory, and relaying a payee's delivery so they pay
 * no gas. Without it the API still checks clauses and opens invites, and
 * says plainly that nothing can be written on chain.
 */
export function depsFromConfig(): ApiDeps {
  const profile = networkProfile();
  const deps: ApiDeps = { chain: readerFromProvider(getProvider()) };

  if (profile.intents) deps.oneClick = new OneClickClient({ apiKey: config.intentsApiKey });

  const { accountId, privateKey } = config.relayer;
  if (accountId && privateKey) {
    const provider = getProvider();
    const account = new Account(accountId, provider, privateKey as KeyPairString);
    deps.writer = new FactoryClauseWriter(account, profile);
    deps.caller = callerFromAccount(account);
    deps.relay = (signedDelegate) => relayDelivery(account, signedDelegate, { factoryAccountId: profile.factoryAccountId, provider });
  }
  return deps;
}
