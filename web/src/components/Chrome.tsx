import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Logo } from "./Logo";

const LINKS = [
  { to: "/how-it-works", label: "How it works" },
  { to: "/developers", label: "For agents" },
  { to: "/security", label: "Security" },
  { to: "/mandate", label: "Mandate" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <Link to="/" aria-label="Clausehold home">
          <Logo />
        </Link>
        <nav className="nav-links" aria-label="Main">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav-cta">
          <Link className="btn btn-ghost btn-sm" to="/desk">
            Open the desk
          </Link>
          <Link className="btn btn-primary btn-sm" to="/desk/new">
            Write a clause
          </Link>
        </div>
        <button className="nav-burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
            {open ? <path d="M4 4l10 10M14 4L4 14" /> : <path d="M2 5h14M2 9h14M2 13h14" />}
          </svg>
        </button>
      </div>
      <div className={`nav-sheet wrap ${open ? "open" : ""}`}>
        {LINKS.map((l) => (
          <Link key={l.to} to={l.to}>
            {l.label}
          </Link>
        ))}
        <Link to="/desk">Open the desk</Link>
        <Link className="btn btn-primary" to="/desk/new">
          Write a clause
        </Link>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <Logo />
            <p style={{ maxWidth: 320, marginTop: 16 }}>Pay for finished work on NEAR. The money is held under a clause, and the clause is the only key that moves it.</p>
          </div>
          <div>
            <h4>Product</h4>
            <ul>
              <li><Link to="/how-it-works">How it works</Link></li>
              <li><Link to="/desk">The desk</Link></li>
              <li><Link to="/mandate">Mandate</Link></li>
            </ul>
          </div>
          <div>
            <h4>Build</h4>
            <ul>
              <li><Link to="/developers">For agents</Link></li>
              <li><a href="https://github.com/angelraph/clausehold" target="_blank" rel="noreferrer">GitHub</a></li>
              <li><Link to="/security">Security</Link></li>
            </ul>
          </div>
          <div>
            <h4>Built on</h4>
            <ul>
              <li>NEAR Intents</li>
              <li>Function-call keys</li>
              <li>Meta-transactions</li>
              <li>NEAR AI Cloud</li>
            </ul>
          </div>
        </div>
        <p className="faint" style={{ marginTop: 48, fontSize: 13 }}>
          Built for NEAR HACKATHON, November 2026. Open source under the MIT license.
        </p>
      </div>
    </footer>
  );
}
