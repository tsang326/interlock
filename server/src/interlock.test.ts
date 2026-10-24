/**
 * The guarantees Interlock claims, as tests.
 *
 * Every test here runs with the risk model switched off, because the guarantee must not
 * depend on a language model agreeing with us. The `pnpm test` script blanks
 * OPENAI_API_KEY before this module loads; setting it here would be too late, since
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
import { Interlock } from './core/interlock.js';
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

/** A `show_capture_details` answer for a capture of `value`. */
const captureOf = (value: string, status = 'COMPLETED', currency = 'USD') => ({
  show_capture_details: {
    id: CAPTURE,
    status,
    amount: { currency_code: currency, value },
    seller_receivable_breakdown: {
      gross_amount: { currency_code: currency, value },
      paypal_fee: { currency_code: currency, value: '1.00' },
      net_amount: { currency_code: currency, value: String(Number(value) - 1) },
    },
  },
});

/** A store whose counterparty already has history, so auto-approve rules are reachable. */
function freshStore(tag: string): Store {
  const file = `/tmp/interlock-test-${tag}-${process.pid}.sqlite`;
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
    const interlock = new Interlock(freshStore('understate'), new StubExecutor());
    const proposal = await interlock.submit(
      refund({
        declaredAmount: { value: 1, currency: 'USD' },
        params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '9500.00' } },
      }),
    );
    assert.equal(proposal.status, 'pending');
    assert.deepEqual(proposal.amount, { value: 9500, currency: 'USD' });
  });

  test('a refund with no amount cannot auto-approve, however small it is claimed to be', async () => {
    const interlock = new Interlock(freshStore('noamount'), new StubExecutor());
    const proposal = await interlock.submit(
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
    const interlock = new Interlock(store, new StubExecutor());
    const proposal = await interlock.submit(
      refund({ declaredAmount: { value: 9500, currency: 'USD' } }),
    );
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('allow-small-routine-refund'));
    assert.ok(proposal.policy.matchedRules.includes('guard:declaration-mismatch'));
  });

  test('an honest small refund still runs unattended, and PayPal is called once', async () => {
    const executor = new StubExecutor('succeed', captureOf('20.00'));
    const interlock = new Interlock(freshStore('honest'), executor);
    const proposal = await interlock.submit(
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
    const interlock = new Interlock(freshStore('held'), executor);
    const proposal = await interlock.submit(
      refund({
        declaredAmount: { value: 1, currency: 'USD' },
        params: { capture_id: CAPTURE, amount: { currency_code: 'USD', value: '9500.00' } },
      }),
    );
    assert.equal(proposal.status, 'pending');
    assert.equal(executor.calls.length, 0);
  });

  test('a rejected PayPal call is recorded as failed, never as executed', async () => {
    const interlock = new Interlock(freshStore('failed'), new StubExecutor('reject', captureOf('20.00')));
    const proposal = await interlock.submit(
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
    const interlock = new Interlock(freshStore('silent'), new StubExecutor('succeed', captureOf('20.00')));
    const proposal = await interlock.submit(refund({ declaredAmount: undefined }));
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
    const interlock = new Interlock(store, executor);
    const proposal = await interlock.submit(
      refund({ declaredAmount: { value: 20, currency: 'USD' } }),
    );

    assert.equal(proposal.mismatches.length, 0, 'the agent told the truth about the request');
    assert.equal(proposal.verification.status, 'contradicted');
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('guard:paypal-contradiction'));
    assert.equal(executor.calls.length, 0, 'nothing reached PayPal');
  });

  test('a capture PayPal has already refunded cannot be refunded again', async () => {
    const executor = new StubExecutor('succeed', captureOf('20.00', 'REFUNDED'));
    const interlock = new Interlock(freshStore('alreadyrefunded'), executor);
    // Under the auto-approve ceiling, truthfully declared, against a counterparty with
    // history. Nothing in the request or the agent's account is wrong.
    const proposal = await interlock.submit(refund({ declaredAmount: { value: 20, currency: 'USD' } }));

    assert.equal(proposal.mismatches.length, 0);
    assert.equal(proposal.verification.status, 'contradicted');
    assert.equal(proposal.verification.resourceState, 'REFUNDED');
    assert.equal(proposal.status, 'pending');
    assert.equal(executor.calls.length, 0);
  });

  test('a partly refunded capture is an unknown, not a refusal', async () => {
    // PayPal does allow another refund here; it just will not say how much is left.
    // Interlock must neither block a legitimate action nor bound it on a number it does
    // not have.
    const executor = new StubExecutor('succeed', captureOf('20.00', 'PARTIALLY_REFUNDED'));
    const interlock = new Interlock(freshStore('partialrefund'), executor);
    const proposal = await interlock.submit(refund({ declaredAmount: { value: 20, currency: 'USD' } }));

    assert.equal(proposal.verification.status, 'unavailable');
    assert.match(proposal.verification.error ?? '', /remainder/i);
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.policy.matchedRules.includes('guard:paypal-unconfirmed'));
    assert.equal(executor.calls.length, 0);
  });

  test('a refund with no amount gets a real figure from PayPal, and a rule can then bound it', async () => {
    const interlock = new Interlock(freshStore('wholecapture'), new StubExecutor('succeed', captureOf('4200.00')));
    const proposal = await interlock.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

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
    const interlock = new Interlock(freshStore('smallcapture'), executor);
    const proposal = await interlock.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

    // "Refund the whole capture" was previously unbounded by definition. It is bounded
    // now, because PayPal was asked what the whole capture is.
    assert.equal(proposal.verification.status, 'confirmed');
    assert.equal(proposal.status, 'executed');
    assert.equal(executor.calls.length, 1);
  });

  test('a lookup that fails is never read as a lookup that passed', async () => {
    // The stub answers nothing, so the verification call throws.
    const executor = new StubExecutor();
    const interlock = new Interlock(freshStore('lookupfail'), executor);
    const proposal = await interlock.submit(refund({ declaredAmount: undefined, params: { capture_id: CAPTURE } }));

    assert.equal(proposal.verification.status, 'unavailable');
    assert.ok(proposal.verification.error);
    assert.equal(proposal.verification.findings.length, 0, 'silence is not a finding against the agent');
    assert.equal(proposal.status, 'pending');
    // No rule can match an amount nobody could establish, and Interlock holds whatever it
    // was not explicitly told to allow rather than falling through to execution.
    assert.deepEqual(proposal.policy.matchedRules, []);
    assert.equal(executor.calls.length, 0);
  });

  test('conceding a dispute is priced by PayPal, not by the agent', async () => {
    const interlock = new Interlock(
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
    const proposal = await interlock.submit({
      kind: 'accept_dispute_claim',
      sessionId: 'test',
      rationale: 'Customer says the goods never arrived; conceding is cheaper than fighting it.',
      declaredAmount: { value: 40, currency: 'USD' },
      // The toolkit validates this note against its dispute-id regex, so it may not
      // contain spaces. Interlock refuses a malformed proposal here rather than at the
      // moment money is meant to move.
      params: { dispute_id: 'PP-D-9001', note: 'customer-request' },
    });

    assert.deepEqual(proposal.verification.amount, { value: 860, currency: 'USD' });
    assert.ok(proposal.verification.findings.some((f) => f.includes('860.00')));
    assert.equal(proposal.status, 'pending');
  });

  test('cancelling a subscription PayPal has already cancelled is a contradiction', async () => {
    const interlock = new Interlock(
      freshStore('subcancelled'),
      new StubExecutor('succeed', {
        show_subscription_details: {
          id: 'I-BW452GLLEP1G',
          status: 'CANCELLED',
          billing_info: { last_payment: { amount: { currency_code: 'USD', value: '79.00' } } },
        },
      }),
    );
    const proposal = await interlock.submit({
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
    store.append('proposal.executed', 'interlock', { live: false }, 'p1');
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

  test('the demo tamper breaks the chain and the demo restore puts it back exactly', () => {
    const store = freshStore('tamper-restore');
    store.append('proposal.created', 'agent', { a: 1 }, 'p1');
    store.append('proposal.approved', 'sang', { note: 'ok' }, 'p1');
    store.append('proposal.executed', 'interlock', { live: false }, 'p1');

    const edited = store.demoTamper();
    store.demoTamper(); // a second tamper must not overwrite the saved original
    assert.equal(store.verifyChain().ok, false);
    assert.equal(store.verifyChain().brokenAt, edited!.seq);

    assert.deepEqual(store.demoRestore(), [edited!.seq]);
    assert.equal(store.verifyChain().ok, true);
    assert.deepEqual(store.demoRestore(), []);
  });

  test('KNOWN LIMIT: truncating the tail is not detectable from inside the chain', () => {
    const store = freshStore('truncate');
    store.append('proposal.created', 'agent', { a: 1 }, 'p1');
    store.append('proposal.executed', 'interlock', { live: false }, 'p1');
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
    const interlock = new Interlock(store, new StubExecutor());
    const app = createApi(store, interlock, new PayPalExecutor());
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    // A proposal that is held, so there is something left to decide.
    const proposal = await interlock.submit(
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

  test('the read route refuses anything that is not a read, including by its real name', async () => {
    const { base, close } = await serve();
    try {
      // `create_refund` is a real PayPal tool and a real Interlock action kind. Naming it
      // here must fail the same way as naming nonsense: reads and writes do not share
      // a door.
      for (const tool of ['create_refund', 'cancel_subscription', 'pay_order', 'not_a_tool']) {
        const response = await fetch(`${base}/api/paypal/read`, {
          method: 'POST',
          headers: { ...AGENT, 'content-type': 'application/json' },
          body: JSON.stringify({ tool, params: {} }),
        });
        assert.equal(response.status, 403, `${tool} should not be readable`);
        assert.equal(((await response.json()) as { error: string }).error, 'not_readable');
      }

      const unauthenticated = await fetch(`${base}/api/paypal/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'list_invoices', params: {} }),
      });
      assert.equal(unauthenticated.status, 401);
    } finally {
      close();
    }
  });

  test('a read this deployment cannot answer says so, rather than failing at PayPal', async () => {
    const { base, close } = await serve();
    try {
      // Two of the sixteen allow-listed reads cannot answer in the sandbox: one needs a
      // scope this app was never granted, the other is refused by the toolkit. They stay
      // allow-listed, so the answer must name the reason and point at what does work —
      // and the health count must not advertise them.
      for (const tool of ['get_shipment_tracking', 'get_merchant_insights']) {
        const response = await fetch(`${base}/api/paypal/read`, {
          method: 'POST',
          headers: { ...AGENT, 'content-type': 'application/json' },
          body: JSON.stringify({ tool, params: {} }),
        });
        assert.equal(response.status, 501, `${tool} should answer with its reason`);
        const body = (await response.json()) as {
          error: string;
          detail: string;
          callable: string[];
        };
        assert.equal(body.error, 'unavailable_here');
        assert.match(body.detail, /read-only tool, but /);
        assert.ok(!body.callable.includes(tool), `${tool} should not be offered as callable`);
        assert.ok(body.callable.includes('list_invoices'));
      }

      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        readOnlyTools: number;
        readsAllowListed: number;
        readsUnavailableHere: string[];
      };
      assert.equal(health.readsAllowListed, 16);
      assert.equal(health.readOnlyTools, 14);
      assert.deepEqual(health.readsUnavailableHere.sort(), [
        'get_merchant_insights',
        'get_shipment_tracking',
      ]);
    } finally {
      close();
    }
  });

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

describe('the demo cannot be made to spend without a ceiling', () => {
  /**
   * The deployed demo publishes its URL and its tokens, and an agent run is a
   * multi-turn model conversation. So the interesting question is not whether a
   * stranger can start a run — they can, that is the demo — but whether they can
   * start an unbounded number of them.
   */
  async function serve(agentRunBudget: number) {
    const store = freshStore(`budget-${Math.random().toString(36).slice(2, 8)}`);
    const interlock = new Interlock(store, new StubExecutor());
    const app = createApi(store, interlock, new PayPalExecutor(), { agentRunBudget });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  const run = (base: string, headers: Record<string, string>) =>
    fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'msg-5150' }),
    });

  test('a spent budget refuses the run and says so, rather than spending anyway', async () => {
    const s = await serve(0);
    try {
      const response = await run(s.base, { authorization: 'Bearer demo-reviewer-token' });
      assert.equal(response.status, 429);
      const body = (await response.json()) as { error: string; budget: number };
      assert.equal(body.error, 'agent_budget_spent');
      assert.equal(body.budget, 0);
    } finally {
      s.close();
    }
  });

  test('an agent token cannot start a run, so it cannot spend the budget it benefits from', async () => {
    const s = await serve(5);
    try {
      const response = await run(s.base, { authorization: 'Bearer demo-agent-token' });
      assert.equal(response.status, 403);
    } finally {
      s.close();
    }
  });

  test('an unauthenticated caller cannot start a run', async () => {
    const s = await serve(5);
    try {
      const response = await run(s.base, {});
      assert.equal(response.status, 401);
    } finally {
      s.close();
    }
  });

  test('health states the ceiling, so it is visible rather than a surprise', async () => {
    const s = await serve(3);
    try {
      const health = (await (await fetch(`${s.base}/api/health`)).json()) as {
        agentRuns: { started: number; budget: number };
      };
      assert.deepEqual(health.agentRuns, { started: 0, budget: 3 });
    } finally {
      s.close();
    }
  });
});

describe('a burst is five in ten minutes, not five in the table', () => {
  /**
   * The velocity rule asks whether five of the same action were filed in the ten minutes
   * before this one. Anchoring that window to the clock instead of to the proposal made
   * the question "are there five in the table", which a seeded demo queue answers yes to
   * for ever — blocking the next honest refund and inflating every risk floor with a
   * `repeat_burst` nothing earned.
   */
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  test('refunds filed well apart are not a burst, however many of them there are', async () => {
    const interlock = new Interlock(freshStore('spread'), new StubExecutor());
    // Nine refunds across six hours. Under a clock-anchored window the last ones block.
    const statuses: string[] = [];
    for (let i = 9; i >= 1; i--) {
      const p = await interlock.submit(refund({}), { at: minutesAgo(i * 45) });
      statuses.push(p.status);
    }
    assert.equal(
      statuses.every((s) => s !== 'blocked'),
      true,
      `nothing spread 45 minutes apart should block, got ${statuses.join(',')}`,
    );
  });

  test('six inside ten minutes is a burst, and the sixth is where it stops', async () => {
    const interlock = new Interlock(freshStore('burst'), new StubExecutor());
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      // 45 seconds apart, so all six sit inside one ten-minute window.
      const p = await interlock.submit(refund({}), { at: new Date(Date.now() - (300 - i * 45) * 1000).toISOString() });
      statuses.push(p.status);
    }
    assert.deepEqual(statuses.slice(0, 5).filter((s) => s === 'blocked'), []);
    assert.equal(statuses[5], 'blocked');
  });

  test('the filing time is not something a caller can set', async () => {
    const store = freshStore('backdate');
    const interlock = new Interlock(store, new StubExecutor());
    const app = createApi(store, interlock, new PayPalExecutor());
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      // A caller that backdates its own proposals walks out of every velocity window.
      const response = await fetch(`http://127.0.0.1:${port}/api/proposals`, {
        method: 'POST',
        headers: { authorization: 'Bearer demo-agent-token', 'content-type': 'application/json' },
        body: JSON.stringify({ ...refund({}), at: minutesAgo(10_000), createdAt: minutesAgo(10_000) }),
      });
      assert.equal(response.status, 201);
      const filed = (await response.json()) as { createdAt: string };
      const age = Date.now() - new Date(filed.createdAt).getTime();
      assert.ok(age < 60_000, `the proposal should be filed now, not ${age}ms ago`);
    } finally {
      server.close();
    }
  });
});
