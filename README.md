# Clausehold

Pay a person or an agent for a finished job, on NEAR. The payer funds a clause from whatever chain they already hold, through NEAR Intents, into a sub-account that exists only for that job. The money is held under the clause, and the clause is the only key that moves it: it releases when the work is delivered, and returns to the payer when the clause expires.

> **Status: in progress for NEAR HACKATHON (Nov 1 to 14, 2026).** This README is a stub. Full "do X, see Y" steps, mainnet transaction hashes and the threat model land before submission.

## What is here now

- `src/`: the off-chain desk. It checks a proposed clause against a treasury's mandate (per-clause cap, per-payee and daily caps, a ceiling for payees who have never delivered, allowed assets, deadline) and returns PASS, VETO or ESCALATE before anyone signs. It also holds a hash-chained audit log, per-agent API keys, a second-person approval flow and a kill switch.
- `contracts/` (in progress): the factory and per-clause contracts that enforce the same mandate on chain.

## Try the desk locally

```bash
npm install
npm run dev -- init
npm run dev -- clause editor.testnet 2 --buyer studio-agent.testnet --terms "Cut intro.mp4 to 30 seconds"
```

You should see `Verdict: PASS` and `CLEARED`. Try `12` instead of `2`: it is refused by `newPayeeCeiling`, because `editor.testnet` has never been paid through a released clause.

```bash
npm test
```

## Prior work, disclosed

This repository previously held **CHARTER**, a policy layer for AI trading agents on Binance, built in September 2026 for a different hackathon. Everything up to the tag `pre-hackathon` is that baseline. Everything after it is Clausehold, built for NEAR HACKATHON. The kept pieces (the hash-chained audit log, the rule-engine shape, the approval flow, agent keys) were rewritten around clauses; all Binance and trading code was removed.

## License

MIT
