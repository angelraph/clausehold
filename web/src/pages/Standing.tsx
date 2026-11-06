import { useParams } from "react-router-dom";
import { PageHead } from "../components/Page";

export default function Standing() {
  const { account = "" } = useParams();
  return (
    <>
      <PageHead eyebrow="Standing" title={account} soft="as a payee." />
      <div className="wrap" style={{ paddingBottom: 96 }}>
        <div className="notice notice-violet" style={{ maxWidth: 640 }}>
          Standing appears here once the factory contract is deployed. It is read straight from the chain, so nothing on this page can be edited by us.
        </div>
        <p className="muted" style={{ marginTop: 20, maxWidth: 640 }}>
          Standing is read from the factory contract's public record of every clause this account has been paid through. A payee with released clauses can be offered more than the new-payee ceiling allows.
        </p>
      </div>
    </>
  );
}
