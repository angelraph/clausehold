import { useEffect, useState } from "react";
import { ApiDown, PageHead } from "../components/Page";
import { api, ApiError, loadSettings, type MandateView } from "../lib/api";
import { explorerAccount, useNetwork } from "../lib/network";
import { readFactoryMandate, readFactoryOwner, tokenAmount, tokenSymbol, type ChainMandate } from "../lib/records";

export default function Mandate() {
  const { network } = useNetwork();
  const [m, setM] = useState<MandateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [onChain, setOnChain] = useState<ChainMandate | null>(null);
  const [chainFailed, setChainFailed] = useState(false);

  useEffect(() => {
    api
      .mandate(loadSettings().mandateId)
      .then(setM)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  useEffect(() => {
    setOwner(null);
    setOnChain(null);
    setChainFailed(false);
    Promise.all([readFactoryOwner(network), readFactoryMandate(network)])
      .then(([o, md]) => {
        setOwner(o);
        setOnChain(md);
      })
      .catch(() => setChainFailed(true));
  }, [network]);

  const isDao = !!owner && owner.endsWith(network.id === "testnet" ? ".sputnikv2.testnet" : ".sputnik-dao.near");
  const sym = tokenSymbol(network, network.usdc);

  return (
    <>
      <PageHead eyebrow="The mandate" title="The treasury's rule, set once." soft="Every clause fits it, or is refused before anyone signs." />
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          {error && <ApiDown message={`${error}.`} />}
          {m && (
            <>
              <div className="eyebrow">In plain words</div>
              <p style={{ fontSize: 17, marginTop: 14 }}>"{m.naturalLanguageSource}"</p>
              <div className="mini" style={{ marginTop: 16 }}>
                {[
                  ["Assets", m.limits.allowedAssets.join(", ")],
                  ["Max per clause", m.limits.maxPerClause],
                  ["Second person above", m.limits.confirmAbove],
                  ["Per payee per day", m.limits.perPayeeDailyCap],
                  ["All payees per day", m.limits.dailySpendCap],
                  ["New payee ceiling", m.limits.newPayeeCeiling],
                  ["Longest a clause stays open", m.limits.maxDeadlineMinutes ? `${Math.round(m.limits.maxDeadlineMinutes / 1440)} days` : "No limit"],
                ].map(([k, v]) => (
                  <div className="mini-row" key={String(k)}><span className="faint">{k}</span><span className="mono">{String(v)}</span></div>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 13, marginTop: 12 }}>This is the desk's copy, checked before any wallet prompt so a refusal can name the rule.</p>
            </>
          )}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div className="card card-pad">
            <h2 className="h3">On chain right now</h2>
            {chainFailed && <p className="muted" style={{ margin: "10px 0 0" }}>The factory on {network.label} did not answer. Try again in a moment.</p>}
            {!owner && !chainFailed && <p className="faint" style={{ margin: "10px 0 0" }}>Reading the factory</p>}
            {owner && (
              <>
                <p className="muted" style={{ fontSize: 15, marginTop: 10 }}>
                  {isDao ? (
                    <>The factory belongs to a Sputnik DAO. The rule changes only when the DAO votes for a proposal that calls <span className="mono">set_mandate</span>.</>
                  ) : (
                    <>The factory is owned by a single account for now. The next step is to hand it to a DAO.</>
                  )}
                </p>
                <div className="mini" style={{ marginTop: 12 }}>
                  <div className="mini-row">
                    <span className="faint">Owner</span>
                    <a className="mono" href={explorerAccount(network, owner)} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>{owner}</a>
                  </div>
                  {onChain && (
                    <>
                      <div className="mini-row"><span className="faint">Disputes settled with</span><span className="mono" style={{ wordBreak: "break-all" }}>{onChain.cosigner ?? "no co-signer"}</span></div>
                      <div className="mini-row"><span className="faint">Max per clause</span><span className="mono">{tokenAmount(onChain.max_per_clause)} {sym}</span></div>
                      <div className="mini-row"><span className="faint">Per payee per day</span><span className="mono">{tokenAmount(onChain.per_payee_daily_cap)} {sym}</span></div>
                      <div className="mini-row"><span className="faint">All payees per day</span><span className="mono">{tokenAmount(onChain.daily_cap)} {sym}</span></div>
                      <div className="mini-row"><span className="faint">New payee ceiling</span><span className="mono">{tokenAmount(onChain.new_payee_ceiling)} {sym}</span></div>
                      <div className="mini-row"><span className="faint">Who may write clauses</span><span>{onChain.creators?.length ? onChain.creators.join(", ") : "Anyone"}</span></div>
                      <div className="mini-row"><span className="faint">Paused</span><span>{onChain.paused ? "Yes" : "No"}</span></div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="card card-pad">
            <h2 className="h3">Why set it once</h2>
            <p className="muted" style={{ fontSize: 15 }}>
              A DAO should not vote on a 2 dollar invoice. It votes on the rule, in one Sputnik DAO proposal that calls the factory's set_mandate. After that, clauses inside the rule go out without a vote, clauses outside it are refused, and large ones wait for a second person.
            </p>
            <p className="muted" style={{ fontSize: 15 }}>
              The same rule is checked twice: by the desk, so the refusal can name the rule before a wallet prompt, and by the factory contract on chain, which is the check that counts.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
