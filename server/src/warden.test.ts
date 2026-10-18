/**
 * The guarantees Warden claims, as tests.
 *
 * Every test here runs with the risk model switched off, because the guarantee must not
 * depend on a language model agreeing with us. The `pnpm test` script blanks
 * ANTHROPIC_API_KEY before this module loads; setting it here would be too late, since
 * config.ts reads the environment at import time.
 *
 * Run with: pnpm test
 */
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { Store } from './core/db.js';
import { deriveFacts, findMismatches } from './core/derive.js';
import { seedDefaultRules } from './core/policy.js';
import { createApi } from './http/api.js';
import { Warden } from './core/warden.js';
import { PayPalExecutor, assertSucceeded, type Executor } from './paypal/executor.js';
import type { ActionKind, ProposalInput } from './core/types.js';


const CAPTURE = '1AB23456CD789012E';
const dbs: string[] = [];

/**
 * Validates against PayPal's real schemas (that is local), but never calls PayPal.
 * A security guarantee that needs the network to be proved is not a guarantee.
 */
class StubExecutor implements Executor {
  readonly live = true;
  readonly calls: Array<{ kind: ActionKind; params: unknown }> = [];
  readonly reads: Array<{ name: string; params: unknown }> = [];
  private schemas = new PayPalExecutor();

  constructor(
    private behaviour: 'succeed' | 'reject' = 'succeed',
    /**
     * What PayPal would answer a verification lookup with. The default is a refusal,
     * so every test that does not deliberately supply an answer runs the path where
     * PayPal could not be reached — the one that must never fail open.
     */
    private answers: Record<string, unknown | (() => never)> = {},
  ) {}

  validate(name: string, params: unknown) {
    return this.schemas.validate(name, params);
  }

  async read(name: string, params: unknown): Promise<unknown> {
    this.reads.push({ name, params });
    if (!(name in this.answers)) throw new Error(`stub has no answer for ${name}`);
    return this.answers[name];
  }

  async executeApproved(kind: ActionKind, params: unknown): Promise<unknown> {
    this.calls.push({ kind, params });
    if (this.behaviour === 'reject') throw new Error('PayPal rejected the call.');
    return { id: 'STUB-1', kind };
  }
}

/** A `list_transactions` answer naming one capture of `value`. */
const captureOf = (value: string, currency = 'USD') => ({
  list_transactions: {
    transaction_details: [
      {
        transaction_info: {
          transaction_id: CAPTURE,
          transaction_status: 'S',
          transaction_amount: { currency_code: currency, value },
        },
      },
    ],
  },
});

/** A store whose counterparty already has history, so auto-approve rules are reachable. */
function freshStore(tag: string): Store {
  const file = `/tmp/warden-test-${tag}-${process.pid}.sqlite`;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) unlinkSync(f);
  dbs.push(file);
  const store = new Store(file);
  seedDefaultRules(store);
  store.insertProposal({
    id: 'history',
    createdAt: new Date().toISOString(),
    kind: 'create_invoice',
    params: {},
    rationale: 'history',
    sessionId: 'past',
    status: 'executed',
    amountStatus: 'derived',
    counterparty: CAPTURE,
    counterpartyStatus: 'derived',
    factNotes: [],
    mismatches: [],
    verification: { status: 'not_applicable', findings: [] },
    risk: { score: 0, ruleScore: 0, factors: [], explanation: '', modelBacked: false },
    policy: { decision: 'auto_approve', matchedRules: [], reason: 'history' },
  });
  return store;
}

const refund = (overrides: Partial<ProposalInput>): ProposalInput => ({
  kind: 'create_refund',
  sessionId: 'test',
  rationale: 'Refund.',
  declaredCounterparty: CAPTURE,
  params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '20.00' } },
  ...overrides,
});

after(() => {
  for (const file of dbs) {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) unlinkSync(f);
  }
});

describe('deriving facts from the parameters PayPal will receive', () => {
  test('reads the refund amount when the request carries one', () => {
    const facts = deriveFacts('create_refund', {
      capture_id: CAPTURE,
      amount: { currency_code: 'USD', value: '9500.00' },
    });
    assert.equal(facts.amountStatus, 'derived');
    assert.deepEqual(facts.amount, { value: 9500, currency: 'USD' });
    assert.equal(facts.counterparty, CAPTURE);
  });

  test('a refund with no amount is unverifiable, not zero', () => {
    const facts = deriveFacts('create_refund', { capture_id: CAPTURE });
    assert.equal(facts.amountStatus, 'unverifiable');
    assert.equal(facts.amount, undefined);
    assert.match(facts.notes.join(' '), /entire capture/i);
  });

  test('totals invoice line items and shipping', () => {
    const facts = deriveFacts('create_invoice', {
      currency_code: 'USD',
      shipping_cost: '10.00',
      primary_recipients: [{ billing_info: { email_address: 'ap@example.com' } }],
      items: [
        { name: 'A', quantity: '2', unit_amount: { currency_code: 'USD', value: '30.00' } },
        { name: 'B', quantity: '1', unit_amount: { currency_code: 'USD', value: '5.50' } },
      ],
    });
    assert.deepEqual(facts.amount, { value: 75.5, currency: 'USD' });
    assert.equal(facts.counterparty, 'ap@example.com');
  });

  test('refuses to total mixed currencies rather than guessing', () => {
    const facts = deriveFacts('create_invoice', {
      items: [
        { quantity: '1', unit_amount: { currency_code: 'USD', value: '10.00' } },
        { quantity: '1', unit_amount: { currency_code: 'EUR', value: '10.00' } },
      ],
    });
    assert.equal(facts.amountStatus, 'unverifiable');
  });

  test('an amount held by PayPal rather than the request is unverifiable', () => {
    for (const kind of ['accept_dispute_claim', 'cancel_subscription', 'send_invoice'] as const) {
      assert.equal(deriveFacts(kind, { dispute_id: 'x', subscription_id: 'x', invoice_id: 'x' }).amountStatus, 'unverifiable');
    }
  });

  test('spots a declaration that does not match the request', () => {
    const facts = deriveFacts('create_refund', {
      capture_id: CAPTURE,
      amount: { currency_code: 'USD', value: '9500.00' },
    });
    assert.equal(findMismatches(facts, { value: 1, currency: 'USD' }, CAPTURE).length, 1);
    assert.equal(findMismatches(facts, { value: 9500, currency: 'USD' }, CAPTURE).length, 0);
    // A cent of rounding is not a lie.
    assert.equal(findMismatches(facts, { value: 9500.009, currency: 'USD' }, CAPTURE).length, 0);
  });
});

describe('policy never decides on what the agent says about itself', () => {
  test('an understated refund cannot auto-approve', async () => {
    const warden = new Warden(freshStore('understate'), new StubExecutor());
    const proposal = await warden.submit(
      refund({
        declaredAmount: { value: 1, currency: 'USD' },
        params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '9500.00' } },
      }),
    );
    assert.equal(proposal.status, 'pending');
    assert.deepEqual(proposal.amount, { value: 9500, currency: 'USD' });
  });

  test('a refund with no amount cannot auto-approve, however small it is claimed to be', async () => {
    const warden = new Warden(freshStore('noamount'), new StubExecutor());
    const proposal = await warden.submit(
      refund({
        declaredAmount: { value: 10, currency: 'USD' },
        params: { capture_id: CAPTURE },
      }),
    );
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.amountStatus, 'unverifiable');
  });

  test('the guard holds even when an operator disables the risk rule', async () => {
    const store = freshStore('guard');
    for (const rule of store.listRules()) {
      if (rule.id === 'review-high-risk-score' || rule.id === 'review-unseen-counterparty') {
        store.upsertRule({ ...rule, enabled: false });
      }
    }
    const warden = new Warden(store, new StubExecutor());
    const proposal = await warden.submit(
      refund({ declaredAmount: { value: 9500, currency: 'USD' } }),
    );
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('allow-small-routine-refund'));
    assert.ok(proposal.policy.matchedRules.includes('guard:declaration-mismatch'));
  });

  test('an honest small refund still runs unattended, and PayPal is called once', async () => {
    const executor = new StubExecutor();
    const warden = new Warden(freshStore('honest'), executor);
    const proposal = await warden.submit(
      refund({ declaredAmount: { value: 20, currency: 'USD' } }),
    );
    assert.equal(proposal.status, 'executed');
    assert.deepEqual(proposal.mismatches, []);
    assert.equal(executor.calls.length, 1);
    // What reached PayPal is the request, not the agent's summary of it.
    assert.deepEqual(executor.calls[0]!.params, {
      capture_id: CAPTURE,
      amount: { currency_code: 'USD', value: '20.00' },
    });
  });

  test('a held proposal never reaches PayPal', async () => {
    const executor = new StubExecutor();
    const warden = new Warden(freshStore('held'), executor);
    const proposal = await warden.submit(
      refund({
        declaredAmount: { value: 1, currency: 'USD' },
        params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '9500.00' } },
      }),
    );
    assert.equal(proposal.status, 'pending');
    assert.equal(executor.calls.length, 0);
  });

  test('a rejected PayPal call is recorded as failed, never as executed', async () => {
    const warden = new Warden(freshStore('failed'), new StubExecutor('reject'));
    const proposal = await warden.submit(
      refund({ declaredAmount: { value: 20, currency: 'USD' } }),
    );
    assert.equal(proposal.status, 'failed');
    assert.match(proposal.error ?? '', /rejected/i);
  });

  /**
   * The toolkit never throws: it catches everything and resolves with a JSON string.
   * Both of its failure shapes have to be recognised, or a call that moved no money
   * gets written into the chain as `executed`.
   */
  test('both of the toolkit failure shapes are recognised, not taken for success', () => {
    // What PayPal answered with.
    assert.throws(
      () => assertSucceeded({ ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: 'gone' }),
      /RESOURCE_NOT_FOUND/,
    );
    // The catch-all, which carries neither `ok` nor `status`.
    assert.throws(
      () => assertSucceeded({ error: { message: 'connection reset', type: 'paypal_error' } }),
      /connection reset/,
    );
    // And a real success still passes through untouched.
    const ok = { id: 'INV2-ABCD', status: 'DRAFT' };
    assert.equal(assertSucceeded(ok), ok);
  });

  test('a proposal that claims nothing is judged on the request alone', async () => {
    const warden = new Warden(freshStore('silent'), new StubExecutor());
    const proposal = await warden.submit(refund({ declaredAmount: undefined }));
    assert.equal(proposal.status, 'executed');
  });
});

/**
 * The half of the problem that cannot be solved by reading the request harder. What a
 * capture took, what a dispute is worth, what a subscription bills — none of that is in
 * the parameters, and the agent's word for it was never going to be enough.
 */
describe('what PayPal itself says', () => {
  test('a refund larger than the capture it draws on is caught, and only PayPal could say so', async () => {
    // Every rule that would have held this anyway is switched off, so what remains is
    // the contradiction itself.
    const store = freshStore('overrefund');
    for (const rule of store.listRules()) {
      if (rule.id === 'review-high-risk-score' || rule.id === 'review-unseen-counterparty') {
        store.upsertRule({ ...rule, enabled: false });
      }
    }
    // The request asks for 20.00, which is under the auto-approve ceiling and matches
    // what the agent claims. Nothing in the parameters is wrong.
    const executor = new StubExecutor('succeed', captureOf('5.00'));
    const warden = new Warden(store, executor);
    const proposal = await warden.submit(
      refund({ declaredAmount: { value: 20, currency: 'USD' } }),
    );

    assert.equal(proposal.mismatches.length, 0, 'the agent told the truth about the request');
    assert.equal(proposal.verification.status, 'contradicted');
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('guard:paypal-contradiction'));
    assert.equal(executor.calls.length, 0, 'nothing reached PayPal');
  });

  test('a refund with no amount gets a real figure from PayPal, and a rule can then bound it', async () => {
    const warden = new Warden(freshStore('wholecapture'), new StubExecutor('succeed', captureOf('4200.00')));
    const proposal = await warden.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

    // The request is still silent — that fact does not change.
    assert.equal(proposal.amountStatus, 'unverifiable');
    // But the action is no longer unbounded: it is 4,200, and the large-amount rule
    // holds it on that figure rather than a guard holding it on ignorance.
    assert.deepEqual(proposal.verification.amount, { value: 4200, currency: 'USD' });
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('review-large-amount'));
  });

  test('the same refund runs unattended once PayPal shows the capture is small', async () => {
    const executor = new StubExecutor('succeed', captureOf('12.00'));
    const warden = new Warden(freshStore('smallcapture'), executor);
    const proposal = await warden.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

    // "Refund the whole capture" was previously unbounded by definition. It is bounded
    // now, because PayPal was asked what the whole capture is.
    assert.equal(proposal.verification.status, 'confirmed');
    assert.equal(proposal.status, 'executed');
    assert.equal(executor.calls.length, 1);
  });

  test('a lookup that fails is never read as a lookup that passed', async () => {
    // The stub answers nothing, so the verification call throws.
    const executor = new StubExecutor();
    const warden = new Warden(freshStore('lookupfail'), executor);
    const proposal = await warden.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

    assert.equal(proposal.verification.status, 'unavailable');
    assert.ok(proposal.verification.error);
    assert.equal(proposal.verification.findings.length, 0, 'silence is not a finding against the agent');
    assert.equal(proposal.status, 'pending');
    // No rule can match an amount nobody could establish, and Warden holds whatever it
    // was not explicitly told to allow rather than falling through to execution.
    assert.deepEqual(proposal.policy.matchedRules, []);
    assert.equal(executor.calls.length, 0);
  });

  test('conceding a dispute is priced by PayPal, not by the agent', async () => {
    const warden = new Warden(
      freshStore('dispute'),
      new StubExecutor('succeed', {
        get_dispute: {
          dispute_id: 'PP-D-9001',
          status: 'WAITING_FOR_SELLER_RESPONSE',
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          dispute_amount: { currency_code: 'USD', value: '860.00' },
        },
      }),
    );
    const proposal = await warden.submit({
      kind: 'accept_dispute_claim',
      sessionId: 'test',
      rationale: 'Customer says the goods never arrived; conceding is cheaper than fighting it.',
      declaredAmount: { value: 40, currency: 'USD' },
      // The toolkit validates this note against its dispute-id regex, so it may not
      // contain spaces. Warden refuses a malformed proposal here rather than at the
      // moment money is meant to move.
      params: { dispute_id: 'PP-D-9001', note: 'customer-request' },
    });

    assert.deepEqual(proposal.verification.amount, { value: 860, currency: 'USD' });
    assert.ok(proposal.verification.findings.some((f) => f.includes('860.00')));
    assert.equal(proposal.status, 'pending');
  });

  test('cancelling a subscription PayPal has already cancelled is a contradiction', async () => {
    const warden = new Warden(
      freshStore('subcancelled'),
      new StubExecutor('succeed', {
        show_subscription_details: {
          id: 'I-BW452GLLEP1G',
          status: 'CANCELLED',
          billing_info: { last_payment: { amount: { currency_code: 'USD', value: '79.00' } } },
        },
      }),
    );
    const proposal = await warden.submit({
      kind: 'cancel_subscription',
      sessionId: 'test',
      rationale: 'Customer asked to cancel.',
      params: { subscription_id: 'I-BW452GLLEP1G', payload: { reason: 'Customer request' } },
    });

    assert.equal(proposal.verification.status, 'contradicted');
    assert.equal(proposal.verification.resourceState, 'CANCELLED');
    assert.equal(proposal.status, 'pending');
  });
});

describe('the audit chain', () => {
  test('detects an edited entry and a deleted one', () => {
    const store = freshStore('chain');
    store.append('proposal.created', 'agent', { a: 1 }, 'p1');
    store.append('proposal.approved', 'sang', { note: 'ok' }, 'p1');
    store.append('proposal.executed', 'warden', { live: false }, 'p1');
    assert.equal(store.verifyChain().ok, true);

    const raw = new Database(dbs[dbs.length - 1]!);
    raw.prepare('UPDATE audit SET payload = ? WHERE seq = 2').run(JSON.stringify({ note: 'someone else' }));
    const edited = store.verifyChain();
    assert.equal(edited.ok, false);
    assert.equal(edited.brokenAt, 2);

    raw.prepare('DELETE FROM audit WHERE seq = 2').run();
    const deleted = store.verifyChain();
    assert.equal(deleted.ok, false);
    assert.equal(deleted.brokenAt, 3);
    raw.close();
  });

  test('KNOWN LIMIT: truncating the tail is not detectable from inside the chain', () => {
    const store = freshStore('truncate');
    store.append('proposal.created', 'agent', { a: 1 }, 'p1');
    store.append('proposal.executed', 'warden', { live: false }, 'p1');
    const raw = new Database(dbs[dbs.length - 1]!);
    raw.prepare('DELETE FROM audit WHERE seq = 2').run();
    raw.close();
    // Nothing links forward, so a chopped tail still reconciles. The UI must say
    // "tamper-evident", not "tamper-proof", until the tip is anchored outside the database.
    assert.equal(store.verifyChain().ok, true);
  });
});

describe('the agent cannot decide its own proposals', () => {
  /** Starts the real Express app on an ephemeral port and returns its base URL. */
  async function serve() {
    const store = freshStore(`http-${Math.random().toString(36).slice(2, 8)}`);
    const warden = new Warden(store, new StubExecutor());
    const app = createApi(store, warden, new PayPalExecutor());
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    // A proposal that is held, so there is something left to decide.
    const proposal = await warden.submit(
      refund({
        declaredAmount: { value: 1, currency: 'USD' },
        params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '9500.00' } },
      }),
    );
    assert.equal(proposal.status, 'pending');
    return { base: `http://127.0.0.1:${port}`, proposal, store, close: () => server.close() };
  }

  const AGENT = { authorization: 'Bearer demo-agent-token' };
  const REVIEWER = { authorization: 'Bearer demo-reviewer-token' };

  test('every route but health refuses an unauthenticated caller', async () => {
    const s = await serve();
    try {
      assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
      assert.equal((await fetch(`${s.base}/api/proposals`)).status, 401);
      assert.equal((await fetch(`${s.base}/api/audit`)).status, 401);
      const approve = await fetch(`${s.base}/api/proposals/${s.proposal.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(approve.status, 401);
    } finally {
      s.close();
    }
  });

  test('an agent token may propose and read, but never decide or rewrite policy', async () => {
    const s = await serve();
    try {
      assert.equal((await fetch(`${s.base}/api/proposals`, { headers: AGENT })).status, 200);

      const approve = await fetch(`${s.base}/api/proposals/${s.proposal.id}/approve`, {
        method: 'POST',
        headers: { ...AGENT, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(approve.status, 403);

      const rule = await fetch(`${s.base}/api/rules/review-large-amount`, {
        method: 'PUT',
        headers: { ...AGENT, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'x',
          enabled: false,
          priority: 40,
          when: { amountGte: 500 },
          then: 'auto_approve',
          reason: 'x',
        }),
      });
      assert.equal(rule.status, 403);
    } finally {
      s.close();
    }
  });

  test('the decision is attributed to the token, not to anything in the body', async () => {
    const s = await serve();
    try {
      const response = await fetch(`${s.base}/api/proposals/${s.proposal.id}/reject`, {
        method: 'POST',
        headers: { ...REVIEWER, 'content-type': 'application/json' },
        // A caller claiming to be someone else must not be believed.
        body: JSON.stringify({ by: 'someone-else', note: 'checked the tracking' }),
      });
      assert.equal(response.status, 200);
      const decided = (await response.json()) as { decidedBy: string };
      assert.equal(decided.decidedBy, 'demo-reviewer');

      const entry = s.store.auditEntries(1)[0]!;
      assert.equal(entry.type, 'proposal.rejected');
      assert.equal(entry.actor, 'demo-reviewer');
    } finally {
      s.close();
    }
  });
});
