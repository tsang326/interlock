import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { modelConfigured, config, paypalConfigured, usingDemoTokens } from '../config.js';
import type { Store } from '../core/db.js';
import { ACTION_KINDS, type ProposalStatus } from '../core/types.js';
import { InvalidTransition, SchemaRejection, type Interlock } from '../core/interlock.js';
import {
  READABLE,
  callableReads,
  resourceRef,
  unavailableReason,
  type PayPalExecutor,
} from '../paypal/executor.js';
import { INBOX } from '../agent/inbox.js';
import { lastModelProvider, modelSpend } from '../model.js';
import { runAgent } from '../agent/run.js';
import { callerOf, requireRole } from './auth.js';

const STATUSES: ProposalStatus[] = [
  'pending',
  'approved',
  'rejected',
  'blocked',
  'executed',
  'failed',
  'expired',
];

const ProposalBody = z.object({
  kind: z.enum(ACTION_KINDS),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1).max(4000),
  sessionId: z.string().min(1).max(64),
  // The agent's own account of the action. Recorded and shown; never used to decide.
  declaredAmount: z.object({ value: z.number(), currency: z.string().length(3) }).optional(),
  declaredCounterparty: z.string().max(200).optional(),
});

const AgentRunBody = z.object({ taskId: z.string().min(1).max(64) });

const ReadBody = z.object({
  tool: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
});

const DecisionBody = z.object({
  note: z.string().max(1000).optional(),
});

const RuleBody = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  when: z.object({
    kinds: z.array(z.enum(ACTION_KINDS)).optional(),
    amountGte: z.number().optional(),
    amountLt: z.number().optional(),
    currency: z.string().length(3).optional(),
    counterpartyUnseen: z.boolean().optional(),
    riskScoreGte: z.number().min(0).max(100).optional(),
    velocity: z.object({ countGte: z.number().int().min(1), windowMinutes: z.number().int().min(1) }).optional(),
  }),
  then: z.enum(['auto_approve', 'needs_review', 'block']),
  reason: z.string().min(1).max(500),
});

/** Turns a thrown error into the right status code instead of a blanket 500. */
function fail(res: Response, error: unknown): void {
  if (error instanceof SchemaRejection) {
    res.status(422).json({ error: 'schema_rejected', detail: error.detail });
    return;
  }
  if (error instanceof InvalidTransition) {
    res.status(409).json({ error: 'invalid_transition', detail: error.message });
    return;
  }
  res.status(500).json({ error: 'internal', detail: error instanceof Error ? error.message : String(error) });
}

export function createApi(
  store: Store,
  interlock: Interlock,
  paypal: PayPalExecutor,
  options: { agentRunBudget?: number; agentSpendBudgetUsd?: number; agentRunWindowHours?: number } = {},
) {
  // Spending, not traffic, is what needs the ceiling here: an agent run costs model
  // calls, and this deployment publishes both its URL and its tokens. One run at a
  // time stops a loop from multiplying it. The UI disables the button while a run
  // streams; a caller using curl does not, so the check lives here.
  //
  // Two ceilings, because they answer different questions. The run count is a rolling
  // window: a process that is pinged awake never restarts, so a count that only ever
  // went up would hand the whole demo period to whoever arrived first. Money does not
  // refill, so the dollar ceiling is per process and absolute — a run whose tool
  // results came back large costs several times what a short one does, and no number
  // of runs can express that.
  const agentRunBudget = options.agentRunBudget ?? config.agent.runBudget;
  const agentSpendBudgetUsd = options.agentSpendBudgetUsd ?? config.agent.spendBudgetUsd;
  const windowMs = (options.agentRunWindowHours ?? config.agent.runBudgetWindowHours) * 3_600_000;
  let windowStartedAt = Date.now();
  let agentRunsStarted = 0;
  let agentRunsEver = 0;
  let agentRunInFlight = false;

  /** Opens a fresh window once the old one has run out. */
  const rollWindow = () => {
    if (Date.now() - windowStartedAt < windowMs) return;
    windowStartedAt = Date.now();
    agentRunsStarted = 0;
  };

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    rollWindow();
    res.json({
      ok: true,
      paypal: paypalConfigured ? (config.paypal.sandbox ? 'sandbox' : 'live') : 'simulated',
      riskModel: modelConfigured ? config.model.riskModel : null,
      agentModel: modelConfigured ? config.model.agentModel : null,
      // Claude answers both jobs when OpenAI cannot; this says whether it is set up and
      // which provider answered last.
      fallbackModel: config.fallback.apiKey ? config.fallback.model : null,
      lastProvider: lastModelProvider(),
      // What is callable here, not what is allow-listed: two of the sixteen cannot
      // answer in the sandbox, and a number a reviewer can disprove by clicking is
      // worse than a smaller true one.
      readOnlyTools: callableReads().length,
      readsAllowListed: READABLE.length,
      readsUnavailableHere: READABLE.filter((name) => unavailableReason(name) !== undefined),
      gatedActions: ACTION_KINDS.length,
      demoTamperAvailable: config.paypal.sandbox,
      usingDemoTokens,
      agentRuns: { started: agentRunsStarted, budget: agentRunBudget },
      agentBudget: {
        runsEver: agentRunsEver,
        windowHours: windowMs / 3_600_000,
        windowResetsInMinutes: Math.max(0, Math.ceil((windowStartedAt + windowMs - Date.now()) / 60_000)),
        spentUsd: modelSpend().usd,
        spendBudgetUsd: agentSpendBudgetUsd,
        modelCalls: modelSpend().calls,
      },
    });
  });

  /* ---- the agent ---- */

  app.get('/api/agent/inbox', requireRole('agent', 'reviewer'), (_req, res) => {
    res.json({ tasks: INBOX, available: modelConfigured });
  });

  /**
   * Starts an agent run and streams its steps as newline-delimited JSON.
   *
   * Not server-sent events: `EventSource` cannot carry an Authorization header, which
   * is why `/api/events` is the one open route in this server. A streamed fetch can,
   * so this one stays behind a token like everything else.
   *
   * Starting a run is an operator action, so it needs the reviewer's token. The agent
   * it starts authenticates separately, as an agent, over HTTP — it does not inherit
   * the caller's credentials, and it still cannot approve its own work.
   */
  app.post('/api/agent/run', requireRole('reviewer'), async (req, res) => {
    const parsed = AgentRunBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    const task = INBOX.find((t) => t.id === parsed.data.taskId);
    if (!task) {
      res.status(404).json({ error: 'not_found', detail: `No message ${parsed.data.taskId}.` });
      return;
    }
    // Both of these are refusals about spending, so they are answered before the model
    // is consulted and before anything is counted against the budget.
    if (agentRunInFlight) {
      res.status(409).json({
        error: 'agent_busy',
        detail: 'One agent run at a time. A run is streaming to whoever started it; try again when it ends.',
      });
      return;
    }
    rollWindow();
    if (agentRunsStarted >= agentRunBudget) {
      const minutes = Math.max(1, Math.ceil((windowStartedAt + windowMs - Date.now()) / 60_000));
      res.status(429).json({
        error: 'agent_budget_spent',
        detail:
          `This deployment starts at most ${agentRunBudget} agent runs every ` +
          `${windowMs / 3_600_000} hours, and all of them have been used. The allowance refills in ` +
          `${minutes} minute${minutes === 1 ? '' : 's'}. The runs that were made are still in the queue ` +
          'and the audit log. Raise INTERLOCK_AGENT_RUN_BUDGET to allow more.',
        started: agentRunsStarted,
        budget: agentRunBudget,
        retryAfterMinutes: minutes,
      });
      return;
    }
    const spent = modelSpend().usd;
    if (spent >= agentSpendBudgetUsd) {
      res.status(429).json({
        error: 'agent_spend_spent',
        detail:
          `The model budget for this deployment is $${agentSpendBudgetUsd.toFixed(2)} and $${spent.toFixed(2)} ` +
          'of it has been used, so no further runs start. Everything already decided is still in the queue ' +
          'and the audit log. Raise INTERLOCK_AGENT_SPEND_USD to allow more.',
        spentUsd: spent,
        budgetUsd: agentSpendBudgetUsd,
      });
      return;
    }
    if (!modelConfigured) {
      res.status(503).json({
        error: 'no_model',
        detail: 'The agent needs OPENAI_API_KEY or ANTHROPIC_API_KEY. Interlock itself runs without one.',
      });
      return;
    }

    agentRunsStarted += 1;
    agentRunsEver += 1;
    agentRunInFlight = true;

    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-store');
    // The SSE route sets this against proxies that buffer a stream; a streamed fetch
    // needs it for the same reason, or the trace arrives in one lump at the end.
    res.setHeader('X-Accel-Buffering', 'no');
    const send = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

    try {
      const run = await runAgent(task, paypal, (step) => send({ type: 'step', step }));
      send({ type: 'done', summary: run.summary, proposalIds: run.proposalIds, sessionId: run.sessionId });
    } catch (error) {
      send({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      agentRunInFlight = false;
    }
    res.end();
  });

  /* ---- reading PayPal ---- */

  /**
   * The agent's only way to see PayPal. Interlock holds the credentials and makes the
   * call; the agent gets the answer.
   *
   * The allow-list is the point. A caller naming `create_refund` here is refused in the
   * same breath as one naming a tool that does not exist — this route cannot reach a
   * write even if someone wires it up by mistake, because `executor.read` refuses
   * anything outside the read set a second time.
   */
  app.post('/api/paypal/read', requireRole('agent', 'reviewer'), async (req, res) => {
    const parsed = ReadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    const { tool, params } = parsed.data;
    if (!READABLE.includes(tool)) {
      res.status(403).json({
        error: 'not_readable',
        detail: `${tool} is not a read-only tool. Money-moving actions are filed as proposals, not called.`,
        readable: READABLE,
      });
      return;
    }

    // Allow-listed, but this deployment cannot answer it. Said plainly, with the reason
    // and the list that does work, so the caller retries with a different tool instead
    // of reading a 502 as "PayPal is down".
    const unavailable = unavailableReason(tool);
    if (unavailable) {
      res.status(501).json({
        error: 'unavailable_here',
        detail: `${tool} is a read-only tool, but ${unavailable}.`,
        callable: callableReads(),
      });
      return;
    }
    try {
      res.json({ tool, result: await paypal.read(tool, params) });
    } catch (error) {
      // A PayPal refusal is the agent's problem to handle, not an Interlock fault.
      res.status(502).json({
        error: 'paypal_refused',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /* ---- proposals ---- */

  app.get('/api/proposals', requireRole('agent', 'reviewer'), (req, res) => {
    const status = req.query.status as ProposalStatus | undefined;
    if (status && !STATUSES.includes(status)) {
      res.status(400).json({ error: 'bad_status', detail: `Unknown status ${status}` });
      return;
    }
    const proposals = store.listProposals({ status, limit: 500 });
    res.json(
      proposals.map((p) => ({ ...p, resourceRef: p.result ? resourceRef(p.result) : undefined })),
    );
  });

  app.get<{ id: string }>('/api/proposals/:id', requireRole('agent', 'reviewer'), (req, res) => {
    const proposal = store.getProposal(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ...proposal, resourceRef: proposal.result ? resourceRef(proposal.result) : undefined });
  });

  app.post('/api/proposals', requireRole('agent'), async (req, res) => {
    const parsed = ProposalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    try {
      res.status(201).json(await interlock.submit(parsed.data));
    } catch (error) {
      fail(res, error);
    }
  });

  app.post<{ id: string }>('/api/proposals/:id/approve', requireRole('reviewer'), async (req, res) => {
    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    try {
      res.json(await interlock.approve(req.params.id, callerOf(req).actor, parsed.data.note));
    } catch (error) {
      fail(res, error);
    }
  });

  app.post<{ id: string }>('/api/proposals/:id/reject', requireRole('reviewer'), (req, res) => {
    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    try {
      res.json(interlock.reject(req.params.id, callerOf(req).actor, parsed.data.note));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---- rules ---- */

  app.get('/api/rules', requireRole('agent', 'reviewer'), (_req, res) => res.json(store.listRules()));

  app.put<{ id: string }>('/api/rules/:id', requireRole('reviewer'), (req, res) => {
    const parsed = RuleBody.safeParse({ ...req.body, id: req.params.id });
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', detail: z.prettifyError(parsed.error) });
      return;
    }
    store.upsertRule(parsed.data);
    store.append('policy.updated', callerOf(req).actor, { rule: parsed.data });
    res.json(parsed.data);
  });

  /* ---- audit ---- */

  app.get('/api/audit', requireRole('agent', 'reviewer'), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    res.json(store.auditEntries(limit));
  });

  app.get('/api/audit/verify', requireRole('agent', 'reviewer'), (_req, res) =>
    res.json(store.verifyChain()),
  );

  // Only ever offered against the sandbox: pointed at live PayPal, this endpoint is gone.
  app.post('/api/audit/demo-tamper', requireRole('reviewer'), (_req, res) => {
    if (!config.paypal.sandbox) {
      res.status(403).json({ error: 'demo_only', detail: 'Not available outside the sandbox.' });
      return;
    }
    const edited = store.demoTamper();
    if (!edited) {
      res.status(409).json({ error: 'nothing_to_tamper', detail: 'The log needs at least two entries.' });
      return;
    }
    res.json({ edited, verification: store.verifyChain() });
  });

  app.post('/api/audit/demo-restore', requireRole('reviewer'), (_req, res) => {
    if (!config.paypal.sandbox) {
      res.status(403).json({ error: 'demo_only', detail: 'Not available outside the sandbox.' });
      return;
    }
    res.json({ restored: store.demoRestore(), verification: store.verifyChain() });
  });

  /* ---- live updates ---- */

  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const unsubscribe = interlock.subscribe((event) => {
      // This route cannot carry a token, so it carries a notification and nothing more:
      // an id and the new status. Everything else is fetched back through a guarded read.
      const notice = event.proposal ? { id: event.proposal.id, status: event.proposal.status } : {};
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(notice)}\n\n`);
    });
    // Proxies drop idle streams; a comment every 25s is cheap and keeps it open.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  return app;
}
