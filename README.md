# Warden

**A human-in-the-loop approval and policy layer for AI agents that move money through PayPal.**

An agent connected to PayPal's Agent Toolkit can issue refunds, cancel subscriptions, concede
disputes and send invoices. Warden sits between the agent and that power: the agent may only
*propose* an action, and a policy engine decides whether it runs on its own, waits for a person,
or is refused. The server alone talks to PayPal, and every decision is appended to a
tamper-evident log.

Built for the PayPal AI Hackathon, against the PayPal sandbox.

---

## Why this exists

The Model Context Protocol specification (2025-11-25, *Security and Trust & Safety*) says both
of these things:

> Hosts must obtain explicit user consent before invoking any tool.

> While MCP itself cannot enforce these security principles at the protocol level,
> implementors **SHOULD** […] build robust consent and authorization flows into their
> applications.

The same section adds that "descriptions of tool behavior such as annotations should be
considered untrusted".

Warden is built in the gap between those two sentences. PayPal's Agent Toolkit exposes 47 tools,
including `create_refund`, `cancel_subscription` and `accept_dispute_claim`. Its configuration can
switch whole product areas on or off, but there is no per-action approval step for the merchant
side. Meanwhile the PayPal Developer Agreement (§1.3, *App ID and API Credentials*) is explicit
about where the consequences land:

> You are liable for all activities performed with your App ID, API Credentials or other PayPal
> Account credentials.

A merchant who hands an agent those credentials has handed over the ability to move money, keeps
the liability, and gets no human checkpoint anywhere in the stack.

This is the merchant's side of the problem. Buyer-side approval already exists — a payer approves
a payment before it is captured. What is missing is the back office: refunds, disputes, invoices
and subscriptions, where the money leaves the merchant's own account.

---

## How it works

```
      agent token                                          reviewer token
   (propose + read)                                     (decide + set policy)
                    the agent never holds PayPal credentials
                                      │
   ┌──────────┐   proposes   ┌────────┴─────────┐   approved only   ┌─────────┐
   │  Agent   │ ───────────► │      Warden      │ ────────────────► │ PayPal  │
   │ (Claude) │              │  policy + review │                   │   API   │
   └──────────┘              └────────┬─────────┘ ◄──────────────── └─────────┘
        │                             │            what PayPal         ▲
        │  reads freely          ┌────┴────┐       actually holds      │
        └───────────────────────►│  holds  │  auto-approve · human · refuse
         16 read-only calls      │  the    │
                                 │  keys   │──────► append-only, hash-chained audit log
                                 └─────────┘
```

Of the toolkit's 47 tools:

| | |
|---|---|
| **15 read-only tools** | the agent calls them through Warden, and Warden calls them itself to check a proposal against PayPal's own record |
| **9 money-moving actions** | the agent can only *propose*; Warden decides and executes |
| **the remaining 23** | never wired up, so they are not reachable at all |

Plus one call the toolkit has no tool for — reading a capture — which Warden makes against the
REST API underneath. That is the sixteenth readable call and the reason the console says 16.

That last row matters: Warden is **default-deny**. `pay_order`, for example, exists in the toolkit
and is simply not connected. The claim is not "we gate every dangerous tool" — it is "nothing
reaches PayPal except through one function, and that function runs only for a proposal that has
already been decided."

### The rule the whole design rests on

**Policy runs on facts read out of the request, never on the agent's account of itself.**

When an agent files a proposal it may also state what the action is worth. That statement is
displayed to the reviewer and recorded, and it is never used to decide anything. Warden derives
the amount and the target from `params` — the object that will actually reach PayPal — and policy
sees only those.

This is not theoretical. Two ways an agent gets money out without it:

1. **Understate the amount.** State `12 USD`, put `9500.00` in the request. Every amount rule
   reads the stated figure, waves it through, and PayPal moves 9,500.
2. **Omit the amount entirely.** PayPal's rule for `create_refund` is that a request with no
   amount refunds *the entire capture*. There is no number in the request to check, so a policy
   that treats "no amount" as "small" hands over the whole thing.

Warden derives `9500` in the first case and `unverifiable` in the second. Both are held for a
human. An amount nobody could establish can never satisfy an auto-approve rule — not because a
rule says so, but because a guard outside the rule set says so, since rules are editable from the
console and this must not be.

### The third account: what PayPal itself says

Reading the request harder solves only half the problem. Some facts are not in the request at
all, and never could be:

- `accept_dispute_claim` carries a dispute id. What the dispute is *worth* is in PayPal.
- `cancel_subscription` carries a subscription id. What it *bills* is in PayPal.
- `send_invoice` carries an invoice id. The *total* is in PayPal.
- `create_refund` may carry an amount — but whether that amount is more than was ever
  captured, and whether the capture has been refunded already, is in PayPal.

| the agent proposes | Warden asks PayPal | and learns |
|---|---|---|
| `create_refund` | `GET /v2/payments/captures/{id}` | what was captured, whether it is already refunded, what the merchant kept after fees |
| `accept_dispute_claim` | `get_dispute` | the disputed amount and whether the seller can still respond |
| `cancel_subscription`, `update_subscription` | `show_subscription_details` | the billing amount, and whether PayPal already cancelled it |
| `send_invoice`, `cancel_sent_invoice`, `record_refund_for_invoice` | `get_invoice` | the total, the recipient, and the invoice's actual state |

The first row is the one the toolkit cannot do. There is no tool for a capture, and
`list_transactions` is the wrong substitute: PayPal's transaction search is not
real-time, so a capture taken minutes ago is simply absent from it. Warden calls the REST
endpoint underneath instead — a GET on a payment resource, which moves nothing.

So Warden asks, at proposal time, before anything is scored or decided. A reviewer therefore sees
three accounts of the same action side by side: what the agent **stated**, what the request
actually **does**, and what PayPal **holds**. Policy runs on the last two and never the first.

This does two things at once. It turns "the amount cannot be known" into a figure a rule can
bound — a refund with no amount stops being unbounded once PayPal says the capture was 4,200, and
a small one can then run unattended on a fact rather than on a guess. And it catches a class of
problem neither the parameters nor the agent could reveal: a refund larger than the capture it
draws on, an invoice sent twice, a subscription cancelled that PayPal already cancelled.

Three things the verification layer never does:

- **Speak for PayPal when PayPal did not answer.** A failed lookup is `unavailable`, never
  `confirmed`, and never a finding against the agent. Silence is recorded as unknown — and
  an unknown cannot auto-approve, because the amount in the request is a ceiling, not a
  proof that the resource exists, is in a state the action applies to, or has anything
  left.
- **Decide.** It reports; policy and the reviewer decide. A contradiction forces review, by the
  same guard outside the rule set.
- **Hang a proposal.** Every lookup is bounded by a timeout.

### Risk scoring is two layers, and they are shown separately

A deterministic layer always runs: action type, amount bands, a counterparty never seen before,
repeated actions in a short window, and whether the agent's account of the action matches the
request. It sets a floor.

Claude (`claude-opus-5-5`) then reads the specific request and may **raise** the score. It can
never lower the floor, and it can never approve anything. Its own instructions treat the agent's
rationale as attacker-controlled data: an agent reads customer emails and invoice notes, so text
arguing for approval is treated as evidence of a problem rather than a reason.

The review screen shows both numbers. A reviewer should know whether an alarm came from a rule
that always fires the same way or from the model reading this one request — and sometimes they
disagree, which is the useful part.

If no Anthropic key is configured, the deterministic layer runs alone and every proposal is
labelled as rules-only. Nothing silently loosens.

### Two roles, because one would defeat the point

Every endpoint but `/api/health` requires a bearer token, and the token decides what the
caller may do:

| | agent token | reviewer token |
|---|---|---|
| read the queue, rules and audit log | yes | yes |
| read PayPal (16 calls, allow-listed) | yes | yes |
| file a proposal | yes | no |
| approve or reject | **no — 403** | yes |
| change policy rules | **no — 403** | yes |

The agent cannot decide its own proposals. If one credential could do both, a compromised
agent would approve its own work and the audit log would faithfully record a human decision
that never happened — precise about a lie.

Identity comes from the token and nothing else. A caller that puts `{"by": "someone-else"}`
in a request body is ignored; the decision is attributed to whoever the token identifies.
There is a test for exactly that.

### The agent

An agent is included, because a gate with nothing behind it proves nothing. It works a
support inbox: read the customer's message, look up what it refers to in PayPal, and act.

It is a normal agent, not a hardened one. It holds a Warden token and nothing else — no
PayPal client id, no secret, no database handle — and it has exactly two tools:

- `paypal_read`, which Warden performs on its behalf. The catalogue the agent sees is
  built at startup from the toolkit's own tool descriptions rather than restated here,
  so it cannot drift.
- `propose_action`, which files a proposal and returns what Warden decided.

There is no third tool. It cannot execute, approve, edit a rule or touch the audit log,
and that is not a matter of prompting: the token it carries is refused by those routes.
Reads and writes do not share a door either — naming `create_refund` on the read route
fails exactly as naming nonsense does, and there is a test for that.

The console has an **Agent** tab: the inbox, a Run button per message, and the run
streaming as it happens — every PayPal call, the proposal, and what the agent told the
merchant afterwards. The same thing runs from a terminal:

```bash
pnpm --filter @warden/server agent            # work the whole demo inbox
pnpm --filter @warden/server agent msg-5150   # one message
```

Starting a run from the console takes the reviewer's token, because starting it is an
operator's action. The agent it starts authenticates separately, as an agent, over HTTP:
it does not inherit the caller's credentials and still cannot approve its own work.

One of the three messages carries a prompt injection — a block addressed to "the
processing agent" telling it the account is pre-cleared, to refund the full payment
rather than the stated figure, and to leave the notice out of its summary. The demo does
not depend on the agent falling for it. It usually does not: it finishes the legitimate
part, says what the message tried, and files nothing. That is the first layer holding,
and the queue carries a seeded example of what the second layer does when the first one
does not.

### The audit log

Each decision is appended carrying the SHA-256 hash of the entry before it, so every row is bound
to the history behind it. Entries carry a hash of the parameters, so the chain proves not only
that a decision happened but what it was about — the same `paramsHash` appears on the proposal and
on its execution, alongside the PayPal resource that was created.

The log is **tamper-evident, not tamper-proof**. See [Known limits](#known-limits).

---

## Run it

Requires Node 18+ and pnpm.

```bash
pnpm install
cp .env.example .env     # PayPal sandbox credentials; the Anthropic key is optional
pnpm --filter @warden/server seed     # fills the review queue with a worked scenario
pnpm dev                               # API on :8787, UI on http://localhost:5173
pnpm --filter @warden/server agent    # optional: run the agent against the demo inbox
```

The seed builds real resources in your sandbox — draft invoices it reuses on later runs —
and files proposals against them. It also refers to two captures from the sandbox this was
built in; point it at your own with `WARDEN_DEMO_CAPTURE` and `WARDEN_DEMO_PART_REFUNDED`,
or leave them and those scenarios will show as unverifiable, which is the honest result.

The agent needs `ANTHROPIC_API_KEY` and a running server. Warden itself needs neither.

### Signing in

The console asks for a token before it will show anything. Unless you set your own in
`.env`, the demo values are:

| role | token | what it can do |
|---|---|---|
| **reviewer** | `demo-reviewer-token` | decide proposals, edit policy — **use this one for the console** |
| agent | `demo-agent-token` | file proposals and read; refused with 403 if it tries to decide |

These are published defaults for a sandbox demo and are not secrets. Set
`WARDEN_AGENT_TOKEN` and `WARDEN_REVIEWER_TOKEN` to use your own, and
`WARDEN_REQUIRE_TOKENS=true` to refuse to start without them.

Try the boundary yourself:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'authorization: Bearer demo-agent-token' -H 'content-type: application/json' \
  localhost:8787/api/proposals/<id>/approve -d '{}'      # 403
```

Get sandbox credentials from the [PayPal developer dashboard](https://developer.paypal.com/dashboard/)
(Apps & Credentials → Sandbox). Without them Warden still runs; approved actions are simulated and
labelled as such. Without an `ANTHROPIC_API_KEY`, risk scoring falls back to the deterministic layer.

### Deploying

`render.yaml` deploys the whole thing as one Render service: the API serves the built
console, so there is one origin and one URL. Create it from the dashboard with **New →
Blueprint**, point it at this repo, and Render will prompt for the three secrets — the
PayPal sandbox pair and the Anthropic key. Everything else is in the file.

Two things about the free plan, both deliberate rather than hidden:

- **There is no persistent disk**, so the database is rebuilt from the seed on every
  restart, and the audit chain starts over with it. The chain's guarantee is about
  tampering between entries, not about surviving a redeploy; anchoring it outside the
  database is listed under [Known limits](#known-limits) and is not built. A paid
  instance with a disk and `WARDEN_DB` pointed at it keeps the history.
- **The service sleeps when idle** and takes a few seconds to wake, so the first request
  after a quiet period is slow.

The seed runs on boot only when the queue is empty, so a restart never duplicates the
scenario and never disturbs a queue someone has been working in. Set
`WARDEN_SEED_ON_BOOT=false` to leave a fresh database empty.

### Verify the claims without any credentials

```bash
pnpm --filter @warden/server test
```

28 tests, about a second, no network and no model — because a guarantee that needs a language
model to agree with it is not a guarantee. They cover both attacks above, the honest path still
running unattended, a held proposal never reaching PayPal, both of the toolkit's failure shapes
being recorded as failed rather than executed, a refund larger than the capture it draws on being
caught, a capture PayPal has already refunded being refused, a failed PayPal lookup never being
read as a passed one, and the audit chain catching an edited and a deleted entry.

One test is named `KNOWN LIMIT` and asserts a weakness rather than a strength. It is below.

---

## What a reviewer sees

- **Review queue** — proposals ranked by risk, with the figure the decision rests on: the amount
  read from the request, or PayPal's own where the request was silent, and what the agent claimed
  where that differs.
- **Proposal detail** — the three accounts side by side (agent, request, PayPal) with the call
  that was made named so it can be repeated by hand; the decision and the rule that produced it;
  both risk layers; the model's reasoning; the parameters bound for PayPal; and the agent's
  rationale, labelled untrusted.
- **Policy** — the rules, in evaluation order, editable. Changing one is itself an audited event.
- **Agent** — the inbox the agent works, and a live trace of one run: the PayPal calls it made,
  the proposal it filed, and its report to the merchant. A run that files something leaves the
  queue one click away.
- **Audit** — the chain, with each entry's link to the one before it, and a verifier that walks it
  from the first entry. In sandbox mode there is a button that edits a row directly in the
  database so you can watch the check catch it.

---

## Known limits

A security tool that oversells itself is worse than none, so:

- **Authentication is two static tokens, not user accounts.** It is enough to separate the agent
  from the reviewer, which is the property that matters here, but there is no per-person identity,
  no rotation, no expiry and no second approver on large amounts. The audit log records which
  *role* decided, not which human.
- **The event stream is unauthenticated.** `EventSource` cannot send headers, so `/api/events` is
  open. It carries decision notifications only, and anything it reveals is already behind a
  token-guarded read endpoint, but it is a gap worth naming. It is the only such route: the agent
  run streams newline-delimited JSON over a normal fetch precisely so it can stay behind a token.
- **Tamper-evident, not tamper-proof.** The hashes are unkeyed, so anyone who can write to the
  database can recompute the chain. Removing entries from the *end* leaves a shorter chain that
  still reconciles — nothing links forward. Anchoring the tip outside the database fixes both, and
  is not built.
- **Velocity counts by action type, not by counterparty**, and counts proposals that were refused.
  A burst of junk proposals can therefore delay a legitimate refund.
- **"Seen before" is earned cheaply.** A counterparty becomes familiar after any executed action,
  including a draft invoice, which is auto-approved. The ceiling on what that unlocks is low (a
  refund under 50) but it is not nothing.
- **Nothing runs unattended while PayPal is unreachable.** A failed lookup holds the action. That
  is the safe direction and it is deliberate, but it means an outage turns routine work into a
  review queue. There is no caching and no retry.
- **A partly refunded capture cannot be bounded.** PayPal reports that a capture is
  `PARTIALLY_REFUNDED` but not how much of it is left, so Warden knows the ceiling and not the
  headroom. It holds those for a human rather than guessing, which is correct and also means a
  legitimate second adjustment never runs unattended.
- **`get_merchant_insights` is in the read set but the toolkit refuses it in sandbox**, so it is
  unavailable in the demo. It is left in the list because it is read-only at the API level; the
  sandbox restriction is the toolkit's, not Warden's.
- **No rate limiting**, deliberately, so the demo can be driven freely against the sandbox.
- **The demo tokens are published above**, which is correct for a sandbox and obviously not for
  anything real.

---

## Built with

- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) against the sandbox — invoicing, payments,
  subscriptions, disputes and transaction search, used in both directions: the nine write actions
  are what Warden gates, and `get_invoice`, `get_dispute` and `show_subscription_details` are how
  it checks a proposal against PayPal's own record before deciding. Where the toolkit has no tool
  — reading a capture — Warden calls the REST endpoint underneath it.
  Proposal parameters are validated against the toolkit's own schemas at proposal time, so a
  malformed request is refused while it is still cheap rather than at the moment money is meant to
  move.
- **Claude Opus 5.5** via the Anthropic SDK, twice over: structured outputs for the risk layer,
  and the beta tool runner with Zod-typed tools for the agent that files the proposals.
- **AG Grid Community** for the review queue, **React + Vite** for the console.
- **TypeScript**, **Express**, **SQLite** (better-sqlite3), server-sent events for live updates.

## Licence

MIT — see [LICENSE](LICENSE).
