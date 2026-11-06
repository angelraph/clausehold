import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="wrap page-head" style={{ textAlign: "center", paddingBottom: 120 }}>
      <div className="eyebrow">404</div>
      <h1 className="h2" style={{ marginTop: 14 }}>Nothing is held here.</h1>
      <p className="lead" style={{ margin: "14px auto 0" }}>This page does not exist, or the link was mistyped.</p>
      <div className="hero-actions" style={{ justifyContent: "center" }}>
        <Link className="btn btn-primary" to="/">Back to the start</Link>
        <Link className="btn btn-ghost" to="/desk">Open the desk</Link>
      </div>
    </div>
  );
}
