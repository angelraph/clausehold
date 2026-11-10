# Demo video script (about 2 minutes 30)

Record your screen with your voice. Speak slowly and plainly; the words below are a guide, so say them your own way. Before recording:
- Open https://clausehold.vercel.app on **Testnet**, with your wallet already connected as `clausehold-ops.testnet`.
- Have a second browser tab ready for the payee.
- Open a terminal in the repository with `npm install` done.
- Close notifications. Zoom the browser to about 110%.

---

**0:00 to 0:15. The hook.** Show the home page.

> "When you pay someone for a job, one side always has to trust the other. Clausehold removes that. The money sits in a NEAR account made for this one job, and the only key on that account can do one thing: deliver."

**0:15 to 0:45. Write a job.** Click **Write a clause**. Payee `clausehold.testnet`, amount 2, terms "Cut intro.mp4 to 30 seconds", 30 minutes. Click **Check and open an invite**.

> "Before anyone signs, the desk checks the job against the treasury's rules. Every rule is listed, and it cleared."

Copy the invite link and open it in the second tab. Click **Accept with a passkey**.

> "The person being paid has no wallet and pays no gas. Their browser makes the one key this job will accept."

**0:45 to 1:10. Write it on chain and fund it.** Back on the clause page, click **Write the clause** and approve in the wallet. Then **Fund 2.00 mUSD**.

> "My wallet creates the job's own account on chain. The deposit for storing it comes back later. Now the money is locked in the clause."

Optional: open the clause account on the explorer and point at the single function-call key.

**1:10 to 1:30. Deliver and get paid.** In the payee tab, type a short note, then **Submit delivery**.

> "No wallet popup and no fee. The delivery is signed by that one key, and the clause pays the worker in the same transaction."

Show **Paid**. Back on the clause page, click **Close it and return the NEAR**.

> "Closing the clause deletes its account and sends the storage deposit back to me."

**1:30 to 1:50. Earned standing.** Open **Standing** in the menu, then click `clausehold.testnet`.

> "Every paid job goes into a public record on chain that nobody can edit. A new payee can be offered at most 10. After one paid job, the contract itself lifts that to 25. Limits are earned, not granted. And anyone can embed this badge."

**1:50 to 2:10. Agents hiring agents.** In the terminal, run `npm run mcp:demo` and let it scroll.

> "The same thing works for AI agents. Clausehold is an MCP server. Here one agent hires another, funds the job, the other delivers, gets paid, and the clause closes. Claude Code can do this with one command."

**2:10 to 2:25. Proof.** Run `npm run judge` (or show a finished run) and scroll the PASS lines.

> "One command runs every claim on testnet, including fourteen attempts to cheat: faking a delivery, taking the money back early, the worker key trying to move funds. Every one fails, with its reason code."

Optional: show the DAO on the Mandate page: "The rules belong to a Sputnik DAO; only a vote can change them."

**2:25 to 2:35. Close.** Back to the home page.

> "Clausehold. The money is held under a clause, and the clause is the only key that moves it. Open source, on NEAR."

---

## The X post

Post from your own account, with the video attached:

> Clausehold: pay an agent or a person for finished work on @NEARProtocol.
>
> The money sits in an account made for one job. Its only key can deliver, nothing else. Delivery pays at once, the deadline refunds, and every paid job raises the worker's on-chain standing, which unlocks bigger jobs.
>
> Agents hire agents over MCP. One command runs 24 checks on testnet.
>
> https://clausehold.vercel.app
> https://github.com/angelraph/clausehold
>
> #NEARHackathon
