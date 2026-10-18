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
import { Warden } from './core/warden.js';
import { PayPalExecutor, type Executor } from './paypal/executor.js';
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
  private schemas = new PayPalExecutor();

  constructor(private behaviour: 'succeed' | 'reject' = 'succeed') {}

  validate(name: string, params: unknown) {
    return this.schemas.validate(name, params);
  }

  async executeApproved(kind: ActionKind, params: unknown): Promise<unknown> {
    this.calls.push({ kind, params });
    if (this.behaviour === 'reject') throw new Error('PayPal rejected the call.');
    return { id: 'STUB-1', kind };
  }
}

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

  test('a proposal that claims nothing is judged on the request alone', async () => {
    const warden = new Warden(freshStore('silent'), new StubExecutor());
    const proposal = await warden.submit(refund({ declaredAmount: undefined }));
    assert.equal(proposal.status, 'executed');
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
