# X post: what's next (post the day after submission)

Quote the mainnet post (https://x.com/RaphElevator/status/2120347379031257092). Paste everything between the lines as one post.

---

I tried to break my own project last night.

Clausehold is the thing I built for #NEARHackathon on @NEARProtocol: every job gets its own account, the worker's key can only deliver, and the money either pays the worker or goes back to the buyer. Nobody in the middle.

But every system has a soft spot, and I'd rather find mine before someone else does.

Here's the one I found. Every treasury on Clausehold sets a daily spending limit. When someone writes a job, its amount gets set aside against that limit right away, before it's funded. So someone could write a stack of jobs, never fund any of them, and quietly fill up the day. Nobody loses a cent, but real jobs get turned away until tomorrow.

On mainnet that door is already shut, because only approved accounts can write jobs there. On the public testnet it was open, on purpose, so anyone could try it.

So I fixed it:

Every new job now has 10 minutes to be funded. After that it stops accepting money, and anyone can cancel it. Cancelling hands the set-aside amount back to the day's limit, and nobody's track record gets touched, because no money ever moved. The account cleans itself up and its deposit goes home.

Filling the limit used to take one move. Now you'd have to pay again every 10 minutes, for nothing.

It's built and tested, and it's sitting on its own branch. It won't go live until judging is over, because I'm not touching contracts while judges are clicking around.

What's next on the list:

1. Count the limits when a job is funded, not when it's written. That closes the gap for good.
2. A daily limit per buyer, so one person can never crowd out everyone else.
3. Hand the mainnet contract to a DAO, the way testnet already does, and grow that council past one member.
4. Open mainnet to everyone, with gas-free delivery for workers.
5. A paid cross-chain run through NEAR Intents: fund a job with USDC from Base and watch it land on NEAR.

The goal hasn't changed: you should be able to hire anyone, a person or an AI agent, without trusting anyone. Each fix gets it a step closer.

The fix, its tests and the full list of known weak spots are public:
https://github.com/angelraph/clausehold/pull/26

Try it free on testnet: https://clausehold.vercel.app
