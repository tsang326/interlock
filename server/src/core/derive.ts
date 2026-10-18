import type { ActionKind, FactStatus, Money } from './types.js';

/**
 * Reads the facts of an action out of the parameters that will actually reach PayPal.
 *
 * The agent also *states* an amount and a counterparty when it files a proposal. Those
 * statements are a convenience for the reviewer and nothing else: the agent is the thing
 * being controlled, so policy is never allowed to run on them. Everything the policy
 * engine decides on comes from here.
 *
 * Where the parameters do not carry the fact, the answer is `unverifiable` — not zero,
 * and not the agent's word for it. `unverifiable` can never satisfy an auto-approve rule.
 */

export type DerivedFacts = {
  amount?: Money;
  amountStatus: FactStatus;
  /**
   * Who or what the action acts on, as the request names it. For an invoice that is the
   * recipient's email; for a refund it is a capture id. Those are different kinds of
   * identifier, and `counterpartyKind` says which, so nothing compares one to the other.
   */
  counterparty?: string;
  counterpartyKind?: 'email' | 'resource_id';
  counterpartyStatus: FactStatus;
  /** Reviewer-facing explanations of anything that could not be read, in plain words. */
  notes: string[];
};

/** PayPal sends money as decimal strings. Anything else is not a number we may trust. */
function money(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function at(source: unknown, ...path: string[]): unknown {
  let node: unknown = source;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A `{currency_code, value}` object, as PayPal shapes money everywhere. */
function moneyObject(source: unknown): Money | undefined {
  const value = money(at(source, 'value'));
  const currency = at(source, 'currency_code');
  if (value === undefined || typeof currency !== 'string') return undefined;
  return { value, currency };
}

function text(source: unknown, ...path: string[]): string | undefined {
  const node = at(source, ...path);
  return typeof node === 'string' && node.length > 0 ? node : undefined;
}

/** Sums invoice or order line items, which carry quantity as a string too. */
function sumItems(items: unknown): { total: Money; skipped: number } | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let total = 0;
  let currency: string | undefined;
  let skipped = 0;
  for (const item of items) {
    const unit = moneyObject(at(item, 'unit_amount'));
    const quantity = money(at(item, 'quantity')) ?? 1;
    if (!unit) {
      skipped += 1;
      continue;
    }
    if (currency && unit.currency !== currency) return undefined; // mixed currencies: do not guess
    currency = unit.currency;
    total += unit.value * quantity;
  }
  if (currency === undefined) return undefined;
  return { total: { value: Math.round(total * 100) / 100, currency }, skipped };
}

export function deriveFacts(kind: ActionKind, params: unknown): DerivedFacts {
  const notes: string[] = [];
  const unknown: DerivedFacts = {
    amountStatus: 'unverifiable',
    counterpartyStatus: 'unverifiable',
    notes,
  };

  switch (kind) {
    case 'create_refund': {
      const counterparty = text(params, 'capture_id');
      const amount = moneyObject(at(params, 'amount'));
      if (!amount) {
        // PayPal's rule: a refund with no amount refunds the whole capture. The size of
        // that capture is not in the request, so nothing here can bound this action.
        notes.push(
          'No amount in the refund parameters — PayPal refunds the entire capture. The size cannot be known from the request.',
        );
      }
      return {
        amount,
        amountStatus: amount ? 'derived' : 'unverifiable',
        counterparty,
        counterpartyKind: 'resource_id',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }

    case 'record_refund_for_invoice': {
      const counterparty = text(params, 'invoice_id');
      const amount = moneyObject(at(params, 'amount'));
      if (!amount) notes.push('No amount given — the full invoice amount is recorded as refunded.');
      return {
        amount,
        amountStatus: amount ? 'derived' : 'unverifiable',
        counterparty,
        counterpartyKind: 'resource_id',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }

    case 'create_invoice': {
      const summed = sumItems(at(params, 'items'));
      const shipping = money(at(params, 'shipping_cost'));
      const counterparty = text(params, 'primary_recipients', '0', 'billing_info', 'email_address');
      if (!summed) {
        notes.push('Line items could not be totalled, so the invoice amount is unknown.');
        return { ...unknown, counterparty, counterpartyKind: 'email', counterpartyStatus: counterparty ? 'derived' : 'unverifiable' };
      }
      if (summed.skipped > 0) {
        notes.push(`${summed.skipped} line item(s) had no readable unit amount; the total is incomplete.`);
        return { ...unknown, counterparty, counterpartyKind: 'email', counterpartyStatus: counterparty ? 'derived' : 'unverifiable' };
      }
      const total = {
        value: Math.round((summed.total.value + (shipping ?? 0)) * 100) / 100,
        currency: summed.total.currency,
      };
      return {
        amount: total,
        amountStatus: 'derived',
        counterparty,
        counterpartyKind: 'email',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }

    case 'create_order': {
      const summed = sumItems(at(params, 'items'));
      const currency = text(params, 'currencyCode');
      const shipping = money(at(params, 'shippingCost')) ?? 0;
      const discount = money(at(params, 'discount')) ?? 0;
      notes.push('An order has no counterparty in its parameters.');
      if (!summed || summed.skipped > 0) {
        notes.push('Order line items could not be totalled, so the amount is unknown.');
        return unknown;
      }
      const value = Math.round((summed.total.value + shipping - discount) * 100) / 100;
      return {
        amount: { value, currency: currency ?? summed.total.currency },
        amountStatus: 'derived',
        counterpartyStatus: 'unverifiable',
        notes,
      };
    }

    case 'cancel_subscription':
    case 'update_subscription': {
      const counterparty = text(params, 'subscription_id');
      notes.push(
        'The money at stake lives on the subscription in PayPal, not in this request, so the amount cannot be derived.',
      );
      return {
        amountStatus: 'unverifiable',
        counterparty,
        counterpartyKind: 'resource_id',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }

    case 'cancel_sent_invoice':
    case 'send_invoice': {
      const counterparty = text(params, 'invoice_id');
      notes.push('The invoice total is held by PayPal, not in this request.');
      return {
        amountStatus: 'unverifiable',
        counterparty,
        counterpartyKind: 'resource_id',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }

    case 'accept_dispute_claim': {
      const counterparty = text(params, 'dispute_id');
      notes.push('The disputed amount is held by PayPal, not in this request.');
      return {
        amountStatus: 'unverifiable',
        counterparty,
        counterpartyKind: 'resource_id',
        counterpartyStatus: counterparty ? 'derived' : 'unverifiable',
        notes,
      };
    }
  }
}

/**
 * Compares what the agent said against what the parameters say. A gap here is the
 * signature of an agent that has been steered, or of one summarising carelessly.
 */
export function findMismatches(
  facts: DerivedFacts,
  declaredAmount?: Money,
  declaredCounterparty?: string,
): string[] {
  const mismatches: string[] = [];

  if (declaredAmount && facts.amountStatus === 'derived' && facts.amount) {
    if (declaredAmount.currency !== facts.amount.currency) {
      mismatches.push(
        `Agent stated ${declaredAmount.currency}; the request is in ${facts.amount.currency}.`,
      );
    } else {
      const gap = Math.abs(declaredAmount.value - facts.amount.value);
      // A cent of rounding is not a lie; anything above it is a different number.
      if (gap > 0.01) {
        mismatches.push(
          `Agent stated ${declaredAmount.value} ${declaredAmount.currency}; the request actually moves ${facts.amount.value} ${facts.amount.currency}.`,
        );
      }
    }
  }

  // A claim Warden cannot check is not a contradiction. It is already reflected in
  // `amountStatus`, scored once as `amount_unverifiable`, and it blocks auto-approval on
  // its own. Counting it here as well would double-charge it and cry wolf on routine work.

  // Only compare like with like. An agent may reasonably call the customer "buyer-4471"
  // while the request names a capture id; that is a different kind of identifier, not a
  // contradiction. Emails are comparable, so those are checked.
  if (
    declaredCounterparty &&
    facts.counterpartyKind === 'email' &&
    facts.counterpartyStatus === 'derived' &&
    facts.counterparty &&
    declaredCounterparty.toLowerCase() !== facts.counterparty.toLowerCase()
  ) {
    mismatches.push(
      `Agent named "${declaredCounterparty}"; the invoice is addressed to "${facts.counterparty}".`,
    );
  }

  return mismatches;
}
