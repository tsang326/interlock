import type { DerivedFacts } from './derive.js';
import type { Store } from './db.js';
import type { ActionKind, PolicyOutcome, RiskAssessment, Rule, RuleCondition } from './types.js';

/**
 * What the policy engine is allowed to see. Deliberately not `ProposalInput`: the agent's
 * declared amount and counterparty are not in here, so no rule can be written against them.
 */
export type PolicyFacts = {
  kind: ActionKind;
  facts: DerivedFacts;
  mismatches: string[];
};

/**
 * Rules are evaluated in priority order and the first match decides. Nothing falls
 * through to execution by accident: when no rule matches, the outcome is review.
 */
export const DEFAULT_DECISION: PolicyOutcome = {
  decision: 'needs_review',
  matchedRules: [],
  reason: 'No rule matched. Warden holds anything it was not explicitly told to allow.',
};

export const DEFAULT_RULES: Rule[] = [
  {
    id: 'block-refund-velocity',
    name: 'Refund burst',
    enabled: true,
    priority: 10,
    when: { kinds: ['create_refund'], velocity: { countGte: 3, windowMinutes: 10 } },
    then: 'block',
    reason: 'More than 3 refunds proposed in 10 minutes. A loop or a hijacked agent looks like this.',
  },
  {
    id: 'review-dispute-concession',
    name: 'Conceding a dispute',
    enabled: true,
    priority: 20,
    when: { kinds: ['accept_dispute_claim'] },
    then: 'needs_review',
    reason: 'Accepting a dispute forfeits the money and cannot be undone. A human decides this.',
  },
  {
    id: 'review-high-risk-score',
    name: 'Model flagged high risk',
    enabled: true,
    priority: 30,
    when: { riskScoreGte: 70 },
    then: 'needs_review',
    reason: 'Risk assessment scored this at 70 or above.',
  },
  {
    id: 'allow-invoice-drafting',
    name: 'Invoice drafting',
    enabled: true,
    // Ahead of the amount and counterparty rules: a draft moves no money, and
    // sending it is a separate action that those rules still gate.
    priority: 35,
    when: { kinds: ['create_invoice'] },
    then: 'auto_approve',
    reason: 'Creating a draft invoice moves no money; sending it is a separate action.',
  },
  {
    id: 'review-large-amount',
    name: 'Large amount',
    enabled: true,
    priority: 40,
    when: { amountGte: 500 },
    then: 'needs_review',
    reason: 'Amount is 500 or more.',
  },
  {
    id: 'review-unseen-counterparty',
    name: 'First time with this counterparty',
    enabled: true,
    priority: 50,
    when: { counterpartyUnseen: true },
    then: 'needs_review',
    reason: 'No prior executed action for this counterparty.',
  },
  {
    id: 'allow-small-routine-refund',
    name: 'Small routine refund',
    enabled: true,
    priority: 60,
    when: { kinds: ['create_refund', 'record_refund_for_invoice'], amountLt: 50 },
    then: 'auto_approve',
    reason: 'Refund under 50 to a counterparty seen before.',
  },
];

export function seedDefaultRules(store: Store): void {
  if (store.countRules() > 0) return;
  for (const rule of DEFAULT_RULES) store.upsertRule(rule);
}

function conditionMatches(
  when: RuleCondition,
  subject: PolicyFacts,
  risk: RiskAssessment,
  store: Store,
): boolean {
  // An empty condition would match everything; treat it as a misconfiguration.
  if (Object.keys(when).length === 0) return false;

  const { kind, facts } = subject;

  if (when.kinds && !when.kinds.includes(kind)) return false;
  if (when.currency && facts.amount?.currency !== when.currency) return false;

  if (when.amountGte !== undefined) {
    if (facts.amount === undefined || facts.amount.value < when.amountGte) return false;
  }
  if (when.amountLt !== undefined) {
    if (facts.amount === undefined || facts.amount.value >= when.amountLt) return false;
  }
  if (when.riskScoreGte !== undefined && risk.score < when.riskScoreGte) return false;

  if (when.counterpartyUnseen !== undefined) {
    // Without a counterparty read from the parameters we cannot assert it has been seen.
    const unseen = facts.counterparty ? store.isCounterpartyUnseen(facts.counterparty) : true;
    if (unseen !== when.counterpartyUnseen) return false;
  }

  if (when.velocity) {
    const n = store.countRecentByKind(kind, when.velocity.windowMinutes);
    if (n < when.velocity.countGte) return false;
  }

  return true;
}

export function evaluatePolicy(
  subject: PolicyFacts,
  risk: RiskAssessment,
  store: Store,
): PolicyOutcome {
  const rules = store.listRules().filter((r) => r.enabled);
  const matched: string[] = [];
  let outcome = DEFAULT_DECISION;

  for (const rule of rules) {
    if (!conditionMatches(rule.when, subject, risk, store)) continue;
    matched.push(rule.id);
    outcome = { decision: rule.then, matchedRules: matched, reason: `${rule.name}: ${rule.reason}` };
    break;
  }

  return guardAutoApprove(outcome, subject);
}

/**
 * The last word on auto-approval, and it is not a rule — rules are editable from the
 * console, and this must not be.
 *
 * An action only runs unattended when Warden could read what it does out of the request
 * and the agent's account of it matched. An amount PayPal will decide for us (a refund
 * with no amount takes the whole capture) is not a small amount; it is an unknown one.
 */
function guardAutoApprove(outcome: PolicyOutcome, subject: PolicyFacts): PolicyOutcome {
  if (outcome.decision !== 'auto_approve') return outcome;

  if (subject.mismatches.length > 0) {
    return {
      decision: 'needs_review',
      matchedRules: [...outcome.matchedRules, 'guard:declaration-mismatch'],
      reason: `Held despite "${outcome.reason}" — what the agent stated does not match what the request does. ${subject.mismatches.join(' ')}`,
    };
  }

  if (subject.facts.amountStatus !== 'derived') {
    return {
      decision: 'needs_review',
      matchedRules: [...outcome.matchedRules, 'guard:unverifiable-amount'],
      reason: `Held despite "${outcome.reason}" — the amount cannot be read from the request, so no amount rule can bound it. ${subject.facts.notes.join(' ')}`,
    };
  }

  return outcome;
}
