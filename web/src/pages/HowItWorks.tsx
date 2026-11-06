import { Link } from "react-router-dom";
import { PageHead } from "../components/Page";
import { Reveal } from "../components/Motion";

const STEPS = [
  { t: "Write the clause", d: "The buyer, a person, a DAO or an agent, says what must be delivered, what it is worth, and when it expires. The desk checks it against the mandate before anyone signs, and names the rule if it refuses." },
  { t: "The payee opens a link", d: "Their browser creates one key, from a passkey where it can. Only its public half leaves the browser. No wallet, no sign-up." },
  { t: "The clause gets its own account", d: "The factory creates r-<n>.clausehold.near for this job alone, and adds exactly one key to it: the payee's, allowed to call submit_delivery and nothing else." },
  { t: "Fund it from any chain", d: "NEAR Intents takes USDC or ETH from the chain the buyer already uses and delivers exactly the clause amount, as USDC on NEAR, to the clause account. No bridge." },
  { t: "Deliver without gas", d: "The payee submits the delivery hash, signed with their key. A relayer pays the fee. The contract checks only that the clause's own key made the call." },
  { t: "Release, or return", d: "Delivery before the deadline releases the money to the payee. No delivery by the deadline returns it to the buyer. There is no third way out: no withdraw, no admin key." },
  { t: "The receipt stays", d: "Each outcome is a public event on NEAR. The payee's standing grows with every release, so the next buyer can offer more." },
];

export default function HowItWorks() {
  return (
    <>
      <PageHead eyebrow="How it works" title="Seven steps," soft="and the money only ever moves at the last one." />
      <div className="wrap" style={{ paddingBottom: 96 }}>
        <div className="steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.t} delay={i * 40}>
              <div className="step card card-pad">
                <div>
                  <h2 className="h3">{s.t}</h2>
                  <p className="muted" style={{ margin: "8px 0 0" }}>{s.d}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="card card-pad" style={{ marginTop: 32 }}>
          <h2 className="h3">What happens in a dispute</h2>
          <p className="muted">If a clause has a review window, the buyer can freeze it after delivery. A frozen clause moves only when both the buyer and the mandate's co-signer agree. There is no arbitration engine, and no model decides.</p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 32, flexWrap: "wrap" }}>
          <Link className="btn btn-primary" to="/desk/new">Write a clause</Link>
          <Link className="btn btn-ghost" to="/security">Read the security model</Link>
        </div>
      </div>
    </>
  );
}
