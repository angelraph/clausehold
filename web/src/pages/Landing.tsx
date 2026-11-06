import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Reveal, Roll, useInterval } from "../components/Motion";
import { StatusChip } from "../components/Status";
import { Ticker } from "../components/Ticker";
import { EXAMPLE_EVENTS, LIFECYCLE } from "../lib/examples";

function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
    </svg>
  );
}

function Expand() {
  return (
    <span className="expand" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M7 1h4v4M5 11H1V7M11 1L7 5M1 11l4-4" />
      </svg>
    </span>
  );
}

/** The desk as the hero image: one clause moving through its life, with toasts. */
function HeroDesk() {
  const [step, setStep] = useState(0);
  useInterval(() => setStep((s) => (s + 1) % LIFECYCLE.length), 2600);
  const current = LIFECYCLE[step]!;
  const balance = step === 0 ? "0.00" : step === 3 ? "0.00" : "2.00";
  const editor = step === 3 ? "2.00" : "0.00";

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#2a2638" }} />
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#2a2638" }} />
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "#2a2638" }} />
        <span className="mono faint" style={{ fontSize: 12, marginLeft: 12 }}>clausehold / desk</span>
        <span className="eyebrow" style={{ marginLeft: "auto" }}>Example</span>
      </div>
      <div className="hero-desk">
        <div style={{ padding: 20, borderRight: "1px solid var(--line)" }} className="hide-sm">
          <div className="eyebrow" style={{ marginBottom: 14 }}>Clauses</div>
          {["r-104", "r-103", "r-102", "r-101"].map((id, i) => (
            <div key={id} className="mini-row" style={{ opacity: i === 0 ? 1 : 0.5 }}>
              <span className="mono">{id}</span>
              <StatusChip status={i === 0 ? current.status : i === 2 ? "returned" : "released"} />
            </div>
          ))}
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div className="mono faint" style={{ fontSize: 12 }}>r-104.clausehold.near</div>
              <div className="h3" style={{ marginTop: 4 }}>Cut intro.mp4 to 30 seconds</div>
            </div>
            <StatusChip status={current.status} />
          </div>
          <div className="grid-2" style={{ marginTop: 20 }}>
            <div className="mini">
              <div className="faint" style={{ fontSize: 12 }}>Held in the clause</div>
              <div style={{ fontSize: 28, marginTop: 6 }}>
                <Roll value={balance} /> <span className="faint" style={{ fontSize: 14 }}>USDC</span>
              </div>
            </div>
            <div className="mini">
              <div className="faint" style={{ fontSize: 12 }}>editor.near received</div>
              <div style={{ fontSize: 28, marginTop: 6 }}>
                <Roll value={editor} /> <span className="faint" style={{ fontSize: 14 }}>USDC</span>
              </div>
            </div>
          </div>
          <ol className="timeline" style={{ marginTop: 22 }}>
            {LIFECYCLE.map((l, i) => (
              <li key={l.status} className={i < step ? "done" : i === step ? "now" : ""}>
                <div style={{ fontSize: 14, color: i <= step ? "var(--text)" : "var(--faint)" }}>{l.title}</div>
                <div className="faint" style={{ fontSize: 12.5 }}>{l.detail}</div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="toast toast-in hero-toast" key={step}>
        <StatusChip status={current.status} />
        <div>
          <div style={{ color: "var(--text)" }}>{current.title}</div>
          <div className="faint">{current.detail}</div>
        </div>
      </div>
    </div>
  );
}

const SCRAPS = [
  { t: "Invoice_final_v3.pdf", d: "Sent. No reply in 9 days.", x: "4%", y: "6%" },
  { t: "Bridge to Base", d: "Wrong network. Funds stuck for a day.", x: "52%", y: "2%" },
  { t: "DM from the editor", d: "Hey, any update on payment?", x: "30%", y: "30%" },
  { t: "Multisig vote #212", d: "3 of 5 signers needed for a $40 bill.", x: "2%", y: "54%" },
  { t: "Escrow site", d: "Requires both sides to sign up.", x: "56%", y: "52%" },
  { t: "Agent key", d: "Full access. Could spend everything.", x: "22%", y: "78%" },
];

const BENTO = [
  {
    span: "span-3",
    title: "Fund from any chain",
    soft: "without a bridge.",
    body: "The payer sends USDC or ETH from the chain they already use. NEAR Intents delivers exactly the clause amount to the clause's own account.",
    art: (
      <div className="mini">
        <div className="mini-row"><span className="faint">You send</span><span className="mono">2.01 USDC on Base</span></div>
        <div className="mini-row"><span className="faint">Clause receives</span><span className="mono">2.00 USDC on NEAR</span></div>
        <div className="mini-row"><span className="faint">To</span><span className="mono">r-104.clausehold.near</span></div>
        <div style={{ marginTop: 12 }} className="bar"><i style={{ width: "100%" }} /></div>
      </div>
    ),
  },
  {
    span: "span-3",
    title: "A key that can only deliver.",
    soft: "Nothing else.",
    body: "The person doing the work gets one function-call key. It can submit delivery. It cannot withdraw, transfer or call anything else.",
    art: (
      <div className="mini mono" style={{ fontSize: 12.5 }}>
        <div className="mini-row"><span className="faint">key</span><span>ed25519:7Qx4...m2Lk</span></div>
        <div className="mini-row"><span className="faint">permission</span><span style={{ color: "var(--violet-2)" }}>FunctionCall</span></div>
        <div className="mini-row"><span className="faint">receiver</span><span>r-104.clausehold.near</span></div>
        <div className="mini-row"><span className="faint">methods</span><span>submit_delivery</span></div>
        <div className="mini-row"><span className="faint">deposit</span><span>0</span></div>
      </div>
    ),
  },
  {
    span: "span-2",
    title: "No wallet, no gas",
    soft: "for the person being paid.",
    body: "They sign with a passkey. A relayer pays the fee.",
    art: (
      <div className="toast" style={{ position: "static" }}>
        <StatusChip status="delivered" />
        <div><div style={{ color: "var(--text)" }}>Delivered with Face ID</div><div className="faint">Gas paid by Clausehold</div></div>
      </div>
    ),
  },
  {
    span: "span-2",
    title: "A mandate set once.",
    soft: "No vote per invoice.",
    body: "The treasury sets the rules in one DAO proposal. Every clause after that fits them or is refused.",
    art: (
      <div className="mini">
        <div className="mini-row"><span className="faint">Max per clause</span><span className="mono">25 USDC</span></div>
        <div className="mini-row"><span className="faint">New payee ceiling</span><span className="mono">10 USDC</span></div>
        <div className="notice notice-red" style={{ marginTop: 10, fontSize: 12.5 }}>Refused before signature: newPayeeCeiling</div>
      </div>
    ),
  },
  {
    span: "span-2",
    title: "Receipts anyone can read.",
    soft: "So the next job starts with trust.",
    body: "Every release and return is a public event on NEAR. Standing builds from real outcomes.",
    art: (
      <div className="mini">
        <div className="mini-row"><span className="faint">editor.near</span><span className="mono">12 released</span></div>
        <div className="mini-row"><span className="faint">returned</span><span className="mono">1</span></div>
        <div className="mini-row"><span className="faint">disputes</span><span className="mono">0</span></div>
      </div>
    ),
  },
];

const AUDIENCES = [
  { key: "studios", label: "Studios and small teams", desc: "Pay a contractor the day the work lands, from whatever chain your treasury sits on. No bridge, no chasing invoices, no shared chain needed." },
  { key: "daos", label: "DAOs and treasuries", desc: "Vote on the rule once. Payments inside the mandate go out without a vote; anything outside it is refused or sent to a second signer." },
  { key: "agents", label: "Agents hiring agents", desc: "An agent can hire another agent or a person and pay on delivery. Its own key cannot spend past the mandate, and the worker's key cannot touch the funds." },
];

export default function Landing() {
  const [aud, setAud] = useState("studios");
  const [payee, setPayee] = useState("");
  const navigate = useNavigate();

  return (
    <>
      <section className="hero">
        <div className="hero-glow" />
        <div className="wrap" style={{ position: "relative" }}>
          <Reveal>
            <div className="hero-counter">
              <span className="pulse" />
              <span>Built on NEAR. Payments held under a clause, released on delivery.</span>
            </div>
            <h1 className="display two-tone" style={{ maxWidth: 980 }}>
              Pay when the work is done. <span className="soft">The money waits in its own account, and only the clause can move it.</span>
            </h1>
            <div className="hero-actions">
              <form
                className="hero-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(`/desk/new${payee ? `?payee=${encodeURIComponent(payee)}` : ""}`);
                }}
              >
                <input aria-label="Who are you paying" placeholder="Who are you paying? e.g. editor.near" value={payee} onChange={(e) => setPayee(e.target.value)} />
                <button className="btn btn-primary btn-sm" type="submit">Write a clause</button>
              </form>
              <Link className="btn btn-ghost" to="/how-it-works">See how it works</Link>
            </div>
          </Reveal>
          <Reveal delay={150}>
            <div style={{ marginTop: 56 }}>
              <HeroDesk />
            </div>
          </Reveal>
        </div>
      </section>

      <Ticker label="How clauses move" events={EXAMPLE_EVENTS} />

      <section className="section-tight">
        <div className="wrap">
          <div className="eyebrow" style={{ textAlign: "center" }}>Built on NEAR, end to end</div>
          <div className="built-on">
            {["NEAR Intents", "Sub-accounts", "Function-call keys", "Meta-transactions", "Sputnik DAO", "NEAR AI Cloud"].map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="section rule">
        <div className="wrap">
          <Reveal>
            <h2 className="h2 two-tone" style={{ maxWidth: 820, textAlign: "center", margin: "0 auto" }}>
              Paying one freelancer took five tools. <span className="soft">None of them talked to each other.</span>
            </h2>
          </Reveal>
          <div className="story" style={{ marginTop: 56 }}>
            <Reveal>
              <div className="card card-pad" style={{ height: "100%" }}>
                <div className="eyebrow">Today</div>
                <div className="scatter">
                  {SCRAPS.map((s, i) => (
                    <div key={s.t} className="scrap" style={{ left: s.x, top: s.y, transform: `rotate(${(i % 2 ? 1 : -1) * (2 + i)}deg)` }}>
                      <b>{s.t}</b>
                      {s.d}
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
            <Reveal delay={150}>
              <div className="card card-pad" style={{ height: "100%", borderColor: "rgba(139,61,255,0.35)" }}>
                <div className="eyebrow" style={{ color: "var(--violet-2)" }}>With a clause</div>
                <h3 className="h3" style={{ marginTop: 18 }}>One account, one key, one rule.</h3>
                <p className="muted">The job gets its own account. The payer funds it from any chain. The worker delivers with a passkey. The money moves only when the clause says so.</p>
                <div className="mini" style={{ marginTop: 18 }}>
                  {LIFECYCLE.map((l) => (
                    <div className="mini-row" key={l.status}>
                      <span>{l.title}</span>
                      <StatusChip status={l.status} />
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section rule">
        <div className="wrap">
          <Reveal>
            <h2 className="h2 two-tone" style={{ maxWidth: 820 }}>
              Everything the job needs. <span className="soft">Nothing the job can abuse.</span>
            </h2>
          </Reveal>
          <div className="bento" style={{ marginTop: 48 }}>
            {BENTO.map((b, i) => (
              <Reveal key={b.title} delay={(i % 3) * 80} className={b.span}>
                <div className="card card-pad" style={{ height: "100%", minHeight: 400, display: "flex", flexDirection: "column" }}>
                  <div className="card-head">
                    <h3 className="h3 two-tone">
                      {b.title} <span className="soft">{b.soft}</span>
                    </h3>
                    <Expand />
                  </div>
                  <p className="muted" style={{ fontSize: 15 }}>{b.body}</p>
                  <div className="bento-art">{b.art}</div>
                </div>
              </Reveal>
            ))}
            <Reveal delay={160} className="span-6">
              <div className="card card-pad note-card">
                <div>
                  <h3 className="h3 two-tone">The model explains. <span className="soft">The rule decides.</span></h3>
                  <p className="muted" style={{ maxWidth: 520 }}>NEAR AI Cloud can write a plain note about what was delivered. Only its hash goes on chain, and it never releases money. A rule does.</p>
                </div>
                <div className="mini" style={{ maxWidth: 440, width: "100%" }}>
                  <div className="faint" style={{ fontSize: 12 }}>Delivery note, NEAR AI Cloud</div>
                  <p style={{ margin: "8px 0 0", fontSize: 14 }}>The editor submitted a 30 second cut of intro.mp4, matching the length in the terms.</p>
                  <div className="mono faint" style={{ fontSize: 11.5, marginTop: 10 }}>note_hash 3f9a...c21e</div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section rule">
        <div className="wrap split">
          <Reveal>
            <h2 className="h2">Who it is for</h2>
            <ul className="feature-list">
              {AUDIENCES.map((a) => (
                <li key={a.key} className={aud === a.key ? "on" : ""}>
                  <button onClick={() => setAud(a.key)} aria-expanded={aud === a.key}>
                    <span style={{ fontSize: 17, fontWeight: 500 }}>{a.label}</span>
                    {aud === a.key && <p className="desc">{a.desc}</p>}
                  </button>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={120}>
            <AudiencePanel which={aud} />
          </Reveal>
        </div>
      </section>

      <section className="section-tight">
        <div className="wrap">
          <div className="stats">
            {[
              ["1", "account per job, so a bad job cannot reach any other"],
              ["1", "key on that account, allowed one method"],
              ["0", "gas paid by the person being paid"],
              ["0", "ways to withdraw except release or return"],
            ].map(([n, l], i) => (
              <div className="stat" key={i}>
                <div className="stat-num">{n}</div>
                <div className="stat-label">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section dark-band">
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">For agents and developers</div>
            <h2 className="h2 two-tone" style={{ marginTop: 14 }}>
              One call to hire. <span className="soft">The rest is enforced on chain.</span>
            </h2>
            <p className="muted" style={{ marginTop: 18, maxWidth: 460 }}>An agent proposes a clause over HTTP. The desk checks it against the mandate and opens an invite for the worker. From there, the contract holds the money.</p>
            <Link className="link-arrow" to="/developers" style={{ marginTop: 18 }}>
              Read the agent guide <Arrow />
            </Link>
          </Reveal>
          <Reveal delay={120}>
            <pre className="code">
              <span className="c"># An agent opens a job</span>{"\n"}
              curl -X POST $CLAUSEHOLD/invites \{"\n"}
              {"  "}-H <span className="s">"X-Clausehold-Api-Key: $KEY"</span> \{"\n"}
              {"  "}-d <span className="s">{"'{"}</span>{"\n"}
              {"    "}<span className="k">"payee"</span>: <span className="s">"editor.near"</span>,{"\n"}
              {"    "}<span className="k">"amount"</span>: 2, <span className="k">"asset"</span>: <span className="s">"USDC"</span>,{"\n"}
              {"    "}<span className="k">"terms"</span>: <span className="s">"Cut intro.mp4 to 30 seconds"</span>,{"\n"}
              {"    "}<span className="k">"deadlineMinutes"</span>: 15{"\n"}
              {"  "}<span className="s">{"}'"}</span>{"\n\n"}
              <span className="c"># PASS: an invite link for the worker</span>{"\n"}
              {"{ "}<span className="k">"verdict"</span>: {"{ "}<span className="k">"decision"</span>: <span className="s">"PASS"</span>{" }"},{"\n"}
              {"  "}<span className="k">"invite"</span>: {"{ "}<span className="k">"path"</span>: <span className="s">"/w/Qm3x..."</span>{" } }"}
            </pre>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap" style={{ textAlign: "center" }}>
          <Reveal>
            <h2 className="h2">Pay for work, not for promises.</h2>
            <p className="lead" style={{ margin: "16px auto 0" }}>Write a clause in a minute. The person you pay needs nothing but a link.</p>
            <div className="hero-actions" style={{ justifyContent: "center" }}>
              <Link className="btn btn-primary" to="/desk/new">Write a clause</Link>
              <Link className="btn btn-ghost" to="/desk">Open the desk</Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}

function AudiencePanel({ which }: { which: string }) {
  if (which === "daos") {
    return (
      <div className="card card-pad">
        <div className="eyebrow">Mandate, set by studio.sputnik-dao.near</div>
        <div className="mini" style={{ marginTop: 16 }}>
          {[
            ["Assets", "USDC, USDT"],
            ["Max per clause", "25"],
            ["Per payee per day", "50"],
            ["New payee ceiling", "10"],
            ["Second person above", "15"],
          ].map(([k, v]) => (
            <div className="mini-row" key={k}><span className="faint">{k}</span><span className="mono">{v}</span></div>
          ))}
        </div>
        <div className="notice notice-violet" style={{ marginTop: 14 }}>Approved once, by proposal #1. No vote per invoice since.</div>
      </div>
    );
  }
  if (which === "agents") {
    return (
      <div className="card card-pad">
        <div className="eyebrow">studio-agent hires a translator</div>
        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          <div className="toast"><StatusChip status="open" /><div><div style={{ color: "var(--text)" }}>Clause r-108 written</div><div className="faint">5.00 USDC, open 2 hours</div></div></div>
          <div className="toast"><StatusChip status="refused" /><div><div style={{ color: "var(--text)" }}>Second clause refused</div><div className="faint">perPayeeDailyCap: 50 already committed today</div></div></div>
          <div className="toast"><StatusChip status="released" /><div><div style={{ color: "var(--text)" }}>r-108 released</div><div className="faint">translator.near paid on delivery</div></div></div>
        </div>
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <div className="eyebrow">A studio pays an editor</div>
      <div className="mini" style={{ marginTop: 16 }}>
        <div className="mini-row"><span className="faint">Terms</span><span>Cut intro.mp4 to 30 seconds</span></div>
        <div className="mini-row"><span className="faint">Amount</span><span className="mono">2.00 USDC</span></div>
        <div className="mini-row"><span className="faint">Funded from</span><span>USDC on Base</span></div>
        <div className="mini-row"><span className="faint">Expires</span><span>15 minutes</span></div>
        <div className="mini-row"><span className="faint">Status</span><StatusChip status="released" /></div>
      </div>
    </div>
  );
}
