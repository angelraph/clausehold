import { PageHead } from "../components/Page";

const ITEMS: Array<[string, string]> = [
  ["One account per job", "Each clause lives in its own sub-account. A bug or a dispute in one job cannot reach the money in any other."],
  ["One key, one method", "The only key on a clause account is the payee's function-call key, limited to submit_delivery with no deposit. There is no full-access key, so nobody, including us, can sign anything else for it."],
  ["No withdraw path", "Money leaves a clause in exactly two ways: release to the payee after delivery, or return to the buyer after the deadline."],
  ["The relayer checks before it pays", "Before paying gas, the relayer verifies the signature, the method, the target account, the key's permission and the nonce. A forged or replayed delivery is refused without cost."],
  ["Rules move money, models do not", "NEAR AI Cloud may write a note about a delivery. Only its hash is stored, and nothing waits on it."],
  ["The mandate is checked on chain", "The desk checks every clause so it can name the rule before a wallet prompt. The factory checks again on chain, and that is the check that counts."],
  ["Every decision is recorded", "The desk keeps a hash-chained log of every proposal, verdict and approval. Editing an old line breaks the chain from that point on."],
];

export default function Security() {
  return (
    <>
      <PageHead eyebrow="Security" title="What protects the money," soft="and where the protection stops." />
      <div className="wrap" style={{ paddingBottom: 96 }}>
        <div className="grid-2">
          {ITEMS.map(([t, d]) => (
            <div className="card card-pad" key={t}>
              <h2 className="h3">{t}</h2>
              <p className="muted" style={{ margin: "10px 0 0" }}>{d}</p>
            </div>
          ))}
          <div className="card card-pad" style={{ borderColor: "rgba(255,92,108,0.3)" }}>
            <h2 className="h3">What it does not protect</h2>
            <p className="muted" style={{ margin: "10px 0 0" }}>Whoever holds the invite link can bind the delivery key, so send it privately. A clause with no review window pays on delivery, so use a window for work you want to check first.</p>
          </div>
        </div>
      </div>
    </>
  );
}
