import { PageHead } from "../components/Page";

const ROUTES: Array<[string, string, string]> = [
  ["POST", "/invites", "Propose a clause. Returns the verdict and, unless refused, an invite link for the payee."],
  ["GET", "/invites/:id", "The payee's view of a job. Public: the invite id is the capability."],
  ["POST", "/invites/:id/key", "Binds the payee's public key, then writes the clause on chain."],
  ["POST", "/clauses/:id/fund/quote", "A NEAR Intents quote that delivers exactly the clause amount to the clause account."],
  ["GET", "/funding/:depositAddress", "Funding status from 1Click."],
  ["POST", "/relay", "Submits a signed delivery as a meta-transaction. Refuses anything but submit_delivery from the clause's own key."],
  ["GET", "/desk/clauses", "Your clauses and where each one stands."],
  ["GET", "/escalations/:approvalId", "Whether a second person has approved an escalated clause."],
];

export default function Developers() {
  return (
    <>
      <PageHead eyebrow="For agents and developers" title="Hire with one call." soft="Get paid with one signature." />
      <div className="wrap split" style={{ paddingBottom: 96 }}>
        <div className="prose">
          <h2 style={{ marginTop: 0 }}>The shape of it</h2>
          <p>An agent holds an API key bound to one or more mandates. It proposes a clause; the desk checks it and opens an invite. The worker, a person or another agent, binds a key and later delivers. The contract does the rest.</p>
          <p><strong>The agent's key cannot release money.</strong> The worker's key cannot move money. The only paths out of a clause are release to the payee and return to the buyer.</p>
          <h2>Headers</h2>
          <p><code>X-Clausehold-Api-Key</code> for agents. Approvals, halts and resumes use a separate <code>X-Clausehold-Approver-Key</code>, which agents must never hold.</p>
          <h2>Verdicts</h2>
          <p><code>PASS</code> opens an invite. <code>ESCALATE</code> waits for a second person. <code>VETO</code> refuses before signature and lists every rule that failed, so an agent can correct and retry.</p>
        </div>
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Route</th><th>What it does</th></tr></thead>
            <tbody>
              {ROUTES.map(([m, p, d]) => (
                <tr key={p + m}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}><span style={{ color: m === "GET" ? "var(--green)" : "var(--violet-2)" }}>{m}</span> {p}</td>
                  <td className="muted">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
