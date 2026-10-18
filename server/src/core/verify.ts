import type { Executor } from '../paypal/executor.js';
import type { DerivedFacts } from './derive.js';
import type { ActionKind, Money } from './types.js';

/**
 * The third source of truth.
 *
 * `derive.ts` reads the request. The agent's own account of itself is noise. Neither can
 * say what a dispute is actually worth, what a subscription bills, or how much was taken
 * in a capture that a refund is about to give back — that lives in PayPal, and only
 * PayPal can be asked.
 *
 * So Warden asks. Where the request is silent this turns "the amount cannot be known"
 * into "PayPal says 4,200.00 USD", which is a figure a rule can actually bound. Where
 * the request is *not* silent it produces a second opinion, and a refund larger than the
 * capture it refunds is a contradiction neither the parameters nor the agent could have
 * revealed.
 *
 * Three things this must never do:
 *   - speak for PayPal when PayPal did not answer. A failed lookup is `unavailable`,
 *     never `confirmed`, and never a finding against the agent;
 *   - decide anything. It reports; policy and the reviewer decide;
 *   - delay a proposal indefinitely. Every lookup is bounded by a timeout.
 */

export type VerificationStatus =
  /** PayPal answered, and the request is consistent with the answer. */
  | 'confirmed'
  /** PayPal answered, and the request does not survive the answer. */
  | 'contradicted'
  /** No answer: the call failed, the scope is missing, or the resource was not found. */
  | 'unavailable'
  /** There is nothing to ask PayPal about for this action. */
  | 'not_applicable';

export type Verification = {
  status: VerificationStatus;
  /** The call that was made, named so a reviewer can repeat it by hand. */
  source?: string;
  /** What PayPal says the action is worth. Authoritative where the request was silent. */
  amount?: Money;
  /** How PayPal currently holds the resource, e.g. `CANCELLED`, `PAID`, `RESOLVED`. */
  resourceState?: string;
  /** Facts only PayPal could supply. Shown to the reviewer and scored by `risk.ts`. */
  findings: string[];
  /** Why no answer came back. Present only when the status is `unavailable`. */
  error?: string;
};

export const NOT_CHECKED: Verification = { status: 'not_applicable', findings: [] };

/** PayPal's transaction search will not look further back than this in one query. */
const SEARCH_WINDOW_DAYS = 31;
const LOOKUP_TIMEOUT_MS = 8000;

function money(source: unknown): Money | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const r = source as Record<string, unknown>;
  const raw = r.value;
  const currency = r.currency_code;
  if (typeof currency !== 'string') return undefined;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? { value, currency } : undefined;
}

function at(source: unknown, ...path: string[]): unknown {
  let node: unknown = source;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function str(source: unknown, ...path: string[]): string | undefined {
  const node = at(source, ...path);
  return typeof node === 'string' && node.length > 0 ? node : undefined;
}

/** A lookup that hangs must not hold a proposal open, so every one is bounded. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PayPal did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Asks PayPal what this action is really about.
 *
 * Returns `not_applicable` when the action names no resource to look up, and
 * `unavailable` — never a finding — when the lookup itself fails.
 */
export async function verifyAgainstPayPal(
  kind: ActionKind,
  params: Record<string, unknown>,
  facts: DerivedFacts,
  paypal: Executor,
): Promise<Verification> {
  const plan = planLookup(kind, params);
  if (!plan) return NOT_CHECKED;

  let answer: unknown;
  try {
    answer = await withTimeout(paypal.read(plan.tool, plan.params), LOOKUP_TIMEOUT_MS);
  } catch (error) {
    return {
      status: 'unavailable',
      source: plan.source,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return plan.interpret(answer, facts);
}

type Lookup = {
  tool: string;
  params: Record<string, unknown>;
  /** Human-readable name of the call, for the reviewer. */
  source: string;
  interpret: (answer: unknown, facts: DerivedFacts) => Verification;
};

function planLookup(kind: ActionKind, params: Record<string, unknown>): Lookup | undefined {
  switch (kind) {
    case 'create_refund': {
      const captureId = str(params, 'capture_id');
      if (!captureId) return undefined;
      const end = new Date();
      const start = new Date(end.getTime() - SEARCH_WINDOW_DAYS * 24 * 3600 * 1000);
      return {
        tool: 'list_transactions',
        params: {
          transaction_id: captureId,
          start_date: start.toISOString(),
          end_date: end.toISOString(),
        },
        source: `list_transactions(${captureId})`,
        interpret: (answer, facts) => interpretCapture(answer, facts, captureId),
      };
    }

    case 'accept_dispute_claim': {
      const disputeId = str(params, 'dispute_id');
      if (!disputeId) return undefined;
      return {
        tool: 'get_dispute',
        params: { dispute_id: disputeId },
        source: `get_dispute(${disputeId})`,
        interpret: interpretDispute,
      };
    }

    case 'cancel_subscription':
    case 'update_subscription': {
      const subscriptionId = str(params, 'subscription_id');
      if (!subscriptionId) return undefined;
      return {
        tool: 'show_subscription_details',
        params: { subscription_id: subscriptionId },
        source: `show_subscription_details(${subscriptionId})`,
        interpret: (answer) => interpretSubscription(answer, kind),
      };
    }

    case 'send_invoice':
    case 'cancel_sent_invoice':
    case 'record_refund_for_invoice': {
      const invoiceId = str(params, 'invoice_id');
      if (!invoiceId) return undefined;
      return {
        tool: 'get_invoice',
        params: { invoice_id: invoiceId },
        source: `get_invoice(${invoiceId})`,
        interpret: (answer, facts) => interpretInvoice(answer, facts, kind),
      };
    }

    // A draft invoice and a new order create the resource they describe, so there is
    // nothing in PayPal yet to compare them against.
    case 'create_invoice':
    case 'create_order':
      return undefined;
  }
}

/**
 * The headline case. A refund request either names an amount or does not; either way
 * the capture it draws on is already in PayPal, and its size settles both the unknown
 * and the overdraw.
 */
function interpretCapture(answer: unknown, facts: DerivedFacts, captureId: string): Verification {
  const rows = at(answer, 'transaction_details');
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) {
    return {
      status: 'unavailable',
      source: `list_transactions(${captureId})`,
      findings: [],
      error: `No transaction ${captureId} in the last ${SEARCH_WINDOW_DAYS} days of history. PayPal's transaction search does not look further back in one query, so this is not evidence that the capture does not exist.`,
    };
  }

  const info = at(row, 'transaction_info');
  const captured = money(at(info, 'transaction_amount'));
  const state = str(info, 'transaction_status');
  const findings: string[] = [];

  if (!captured) {
    return {
      status: 'unavailable',
      source: `list_transactions(${captureId})`,
      resourceState: state,
      findings,
      error: 'PayPal returned the transaction without a readable amount.',
    };
  }

  // Captures are positive to the merchant; refunds against them come back negative.
  const gross = Math.abs(captured.value);
  const capture: Money = { value: gross, currency: captured.currency };

  const requested = facts.amountStatus === 'derived' ? facts.amount : undefined;
  if (!requested) {
    findings.push(
      `The request names no amount, so PayPal would refund the whole capture: ${gross.toFixed(2)} ${capture.currency}.`,
    );
    return { status: 'confirmed', source: `list_transactions(${captureId})`, amount: capture, resourceState: state, findings };
  }

  if (requested.currency !== capture.currency) {
    findings.push(
      `The refund is in ${requested.currency} but the capture was taken in ${capture.currency}.`,
    );
    return { status: 'contradicted', source: `list_transactions(${captureId})`, amount: capture, resourceState: state, findings };
  }

  if (requested.value > gross + 0.01) {
    findings.push(
      `The refund asks for ${requested.value.toFixed(2)} ${requested.currency} against a capture of ${gross.toFixed(2)} ${capture.currency} — more than was ever taken.`,
    );
    return { status: 'contradicted', source: `list_transactions(${captureId})`, amount: capture, resourceState: state, findings };
  }

  findings.push(
    `PayPal confirms a capture of ${gross.toFixed(2)} ${capture.currency}; the refund is within it.`,
  );
  return { status: 'confirmed', source: `list_transactions(${captureId})`, amount: capture, resourceState: state, findings };
}

/** Conceding a dispute forfeits whatever PayPal says the dispute is worth. */
function interpretDispute(answer: unknown): Verification {
  const amount = money(at(answer, 'dispute_amount'));
  const state = str(answer, 'status');
  const reason = str(answer, 'reason');
  const source = 'get_dispute';
  const findings: string[] = [];

  if (!amount) {
    return { status: 'unavailable', source, resourceState: state, findings, error: 'PayPal returned the dispute without a readable amount.' };
  }

  findings.push(
    `Conceding this forfeits ${amount.value.toFixed(2)} ${amount.currency}${reason ? `, disputed as ${reason.toLowerCase().replace(/_/g, ' ')}` : ''}.`,
  );

  // A dispute already out of the merchant's hands cannot be conceded; the action would
  // fail, and an agent trying it is doing something it does not understand.
  if (state && !/WAITING_FOR_SELLER_RESPONSE|UNDER_REVIEW|REQUIRED_OTHER_PARTY_ACTION/i.test(state)) {
    findings.push(`PayPal holds this dispute as ${state}, which is not a state a seller can concede from.`);
    return { status: 'contradicted', source, amount, resourceState: state, findings };
  }

  return { status: 'confirmed', source, amount, resourceState: state, findings };
}

/** What a subscription bills is on the subscription, never in a cancel request. */
function interpretSubscription(answer: unknown, kind: ActionKind): Verification {
  const state = str(answer, 'status');
  const source = 'show_subscription_details';
  const findings: string[] = [];

  const amount =
    money(at(answer, 'billing_info', 'last_payment', 'amount')) ??
    money(at(answer, 'billing_info', 'outstanding_balance'));

  if (amount) {
    findings.push(`PayPal bills this subscription ${amount.value.toFixed(2)} ${amount.currency} per cycle.`);
  }
  const nextBilling = str(answer, 'billing_info', 'next_billing_time');
  if (nextBilling) findings.push(`Next billing: ${nextBilling}.`);

  if (state && /CANCELLED|EXPIRED/i.test(state)) {
    findings.push(
      `PayPal already holds this subscription as ${state}, so ${kind.replace(/_/g, ' ')} would change nothing.`,
    );
    return { status: 'contradicted', source, amount, resourceState: state, findings };
  }

  if (!amount) {
    return { status: 'unavailable', source, resourceState: state, findings, error: 'PayPal returned the subscription without a readable billing amount.' };
  }

  return { status: 'confirmed', source, amount, resourceState: state, findings };
}

/** An invoice's total and its state both live in PayPal, not in a send or cancel call. */
function interpretInvoice(answer: unknown, facts: DerivedFacts, kind: ActionKind): Verification {
  const source = 'get_invoice';
  const state = str(answer, 'status');
  const total = money(at(answer, 'amount'));
  const findings: string[] = [];

  if (total) findings.push(`PayPal holds this invoice at ${total.value.toFixed(2)} ${total.currency}.`);
  const recipient = str(answer, 'primary_recipients', '0', 'billing_info', 'email_address');
  if (recipient) findings.push(`Addressed to ${recipient}.`);

  if (kind === 'send_invoice' && state && /^(SENT|PAID|CANCELLED)$/i.test(state)) {
    findings.push(`PayPal already holds this invoice as ${state}; sending it again is not a first send.`);
    return { status: 'contradicted', source, amount: total, resourceState: state, findings };
  }
  if (kind === 'cancel_sent_invoice' && state && /^(PAID|CANCELLED|DRAFT)$/i.test(state)) {
    findings.push(`PayPal holds this invoice as ${state}, which cannot be cancelled as a sent invoice.`);
    return { status: 'contradicted', source, amount: total, resourceState: state, findings };
  }

  if (kind === 'record_refund_for_invoice' && total) {
    const requested = facts.amountStatus === 'derived' ? facts.amount : undefined;
    if (requested && requested.currency === total.currency && requested.value > total.value + 0.01) {
      findings.push(
        `The refund records ${requested.value.toFixed(2)} ${requested.currency} against an invoice of ${total.value.toFixed(2)} ${total.currency}.`,
      );
      return { status: 'contradicted', source, amount: total, resourceState: state, findings };
    }
  }

  if (!total) {
    return { status: 'unavailable', source, resourceState: state, findings, error: 'PayPal returned the invoice without a readable total.' };
  }

  return { status: 'confirmed', source, amount: total, resourceState: state, findings };
}

/**
 * The amount an action should be judged on: what the request binds, or failing that,
 * what PayPal confirmed it comes to. A figure PayPal supplied is at least as sound as
 * one read out of the request, so a rule may bound an action on either.
 */
export function effectiveAmount(facts: DerivedFacts, verification: Verification): Money | undefined {
  if (facts.amountStatus === 'derived' && facts.amount) return facts.amount;
  if (verification.status === 'confirmed' && verification.amount) return verification.amount;
  return undefined;
}
