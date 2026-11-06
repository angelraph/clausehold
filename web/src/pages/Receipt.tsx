import { Link, useParams } from "react-router-dom";
import { PageHead } from "../components/Page";
import { explorerAccount, useNetwork } from "../lib/network";

/**
 * A public receipt. The record itself lives on chain as NEP-297 events
 * emitted by the clause account, so anyone can verify it without trusting
 * this page.
 */
export default function Receipt() {
  const { clause = "" } = useParams();
  const { network } = useNetwork();
  return (
    <>
      <PageHead eyebrow="Public receipt" title={clause} soft="on NEAR." />
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          <h2 className="h3">Verify it yourself</h2>
          <p className="muted" style={{ fontSize: 15 }}>
            Every clause emits a public event when it is funded, delivered, released or returned. This page reads those events; it is not the record. The chain is.
          </p>
          <a className="btn btn-ghost btn-sm" href={explorerAccount(network, clause)} target="_blank" rel="noreferrer">Open in the explorer</a>
        </div>
        <div className="card card-pad">
          <h2 className="h3">What a receipt shows</h2>
          <ul className="muted" style={{ fontSize: 15, paddingLeft: 18 }}>
            <li>Who paid and who was paid</li>
            <li>The amount and asset</li>
            <li>The hash of the terms and of the delivery</li>
            <li>Whether it was released or returned, and when</li>
            <li>The hash of the NEAR AI note, if one was written</li>
          </ul>
          <Link className="link-arrow" to="/how-it-works">How receipts build standing</Link>
        </div>
      </div>
    </>
  );
}
