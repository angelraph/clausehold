# X post for NEAR HACKATHON (X Premium, one long post)

Attach the demo video. Paste everything between the lines as a single post.

---

I kept running into the same problem. Someone does the work, someone pays, and one of them always has to go first and hope the other side is honest.

So for #NEARHackathon I built Clausehold on @NEARProtocol.

The idea is simple. When you hire someone, the payment goes into a NEAR account made just for that one job. That account has a single key, and the key belongs to the worker. It can do exactly one thing: deliver. Not withdraw, not transfer, not call anything else. Delivery pays the worker. If the deadline passes first, anyone can send the money back to you.

Here is how a job goes:

You write what needs doing, the amount and the deadline. Before you sign anything, the desk checks it against your treasury's rules and tells you which rule it breaks, if any.

The worker opens a link and accepts with a passkey. No wallet, no seed phrase, no gas. Their browser makes the one key the job will accept.

You fund it from your own wallet. The worker delivers, the desk pays the network fee, and the money lands with them in the same transaction.

When it's done, anyone can close the job. The account deletes itself and the 2 NEAR storage deposit comes back to you.

The part I'm proudest of is standing. Every paid job leaves a line in the worker's public record that nobody can edit, me included. A new worker can be offered up to 10. After one paid job, the contract itself lifts that to 25. You earn your limits, they aren't handed out. There's a leaderboard, and a badge anyone can put on their profile.

A few other things it does:

- Buyers can add an acceptance check, like "this pull request must be merged" or "this page must say we're live". Every delivery has to pass it before it's sent.
- The rules belong to a Sputnik DAO. Only a vote can change them, and the same DAO settles disputes.
- It works for AI agents. Clausehold is an MCP server, so one agent can hire another, fund the job, get the work and pay for it, all on chain. Claude Code can add it with one command.
- It all fits on a phone.
- It's live on mainnet too. The first real job paid 2 USDC through a clause, and the account closed itself and gave its deposit back.

I didn't want anyone to just take my word for it. One command, npm run judge, runs 25 checks against the live contracts on testnet, including 15 attempts to cheat: faking a delivery, taking the money back early, the worker's key trying to move funds. Every one is refused, with the reason it was refused.

Try it free on testnet, the faucet gives you test tokens: https://clausehold.vercel.app

Code, the threat model and a five minute guide for judges: https://github.com/angelraph/clausehold

Built solo in two weeks. Happy to hear what breaks.
