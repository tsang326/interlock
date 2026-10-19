/**
 * Interlock domain types.
 *
 * An agent never touches PayPal directly. It emits a Proposal; the policy engine
 * decides whether that proposal executes on its own, waits for a human, or is
 * refused outright. Every one of those transitions lands in the audit chain.
 */

import type { Verification } from './verify.js';

/** Money-moving actions an agent may propose. Read-only PayPal calls are not proposals. */
export const ACTION_KINDS = [
  'create_refund',
  'record_refund_for_invoice',
  'cancel_subscription',
  'update_subscription',
  'cancel_sent_invoice',
  'create_invoice',
  'send_invoice',
  'create_order',
  'accept_dispute_claim',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export type Decision = 'auto_approve' | 'needs_review' | 'block';

export type ProposalStatus =
  | 'pending' // waiting on a human
  | 'approved' // human said yes, not executed yet
  | 'rejected' // human said no
  | 'blocked' // policy refused it; no human is offered the choice
  | 'executed' // PayPal call succeeded
  | 'failed' // PayPal call was attempted and errored
  | 'expired'; // sat past its TTL without a decision

export type Money = { value: number; currency: string };

/** Whether a fact could be read out of the PayPal parameters at all. */
export type FactStatus = 'derived' | 'unverifiable';

/**
 * What the agent asked for, before any policy ran.
 *
 * Everything here is the agent's own account of itself. `params` is binding because it
 * is what PayPal will receive; the declared fields are not. Policy never reads them.
 */
export type ProposalInput = {
  kind: ActionKind;
  /** Parameters destined for the PayPal API, shaped per action kind. The binding part. */
  params: Record<string, unknown>;
  /** The agent's own stated reason. Untrusted: it is an LLM output, shown but never relied on. */
  rationale: string;
  /** Opaque id for the agent run that produced this, so one bad run can be traced whole. */
  sessionId: string;
  /** What the agent *says* the action is worth. Shown to the reviewer, never used to decide. */
  declaredAmount?: Money;
  /** Who the agent *says* this affects. Shown to the reviewer, never used to decide. */
  declaredCounterparty?: string;
};

export type RiskAssessment = {
  /** 0-100. Higher is more dangerous. The number policy runs on. */
  score: number;
  /**
   * The deterministic floor, on its own. Kept separate so a reviewer can see which
   * layer raised the alarm: rules that always fire the same way, or the model's
   * reading of this particular request.
   */
  ruleScore: number;
  /** What the model returned, when it ran. Absent means it did not. */
  modelScore?: number;
  /** Short machine-readable reasons, e.g. 'amount_outlier', 'new_counterparty'. */
  factors: string[];
  /** One or two sentences for the reviewer. Model-generated. */
  explanation: string;
  /** False when scoring fell back to deterministic heuristics (no API key, model error). */
  modelBacked: boolean;
};

export type PolicyOutcome = {
  decision: Decision;
  /** Ids of rules that fired, in evaluation order. */
  matchedRules: string[];
  /** Human-readable reason from the deciding rule. */
  reason: string;
};

export type Proposal = ProposalInput & {
  id: string;
  createdAt: string;
  status: ProposalStatus;
  /** Read out of `params`. This — not `declaredAmount` — is what policy and risk run on. */
  amount?: Money;
  amountStatus: FactStatus;
  counterparty?: string;
  counterpartyKind?: 'email' | 'resource_id';
  counterpartyStatus: FactStatus;
  /** Plain-words explanation of anything the parameters did not carry. */
  factNotes: string[];
  /** Gaps between what the agent said and what the parameters do. */
  mismatches: string[];
  /** What PayPal itself says about the resource this action touches. */
  verification: Verification;
  risk: RiskAssessment;
  policy: PolicyOutcome;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** Raw PayPal response on success, so the reviewer can see what actually happened. */
  result?: unknown;
  error?: string;
  executedAt?: string;
};

/* ---------- Policy rules ---------- */

export type RuleCondition = {
  kinds?: ActionKind[];
  amountGte?: number;
  amountLt?: number;
  currency?: string;
  /** Fires when the counterparty has no prior executed proposal. */
  counterpartyUnseen?: boolean;
  riskScoreGte?: number;
  /** Fires when this kind already ran `countGte` times inside the window. */
  velocity?: { countGte: number; windowMinutes: number };
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  /** Lower runs first. The first rule that matches decides. */
  priority: number;
  when: RuleCondition;
  then: Decision;
  reason: string;
};

/* ---------- Audit chain ---------- */

export type AuditEventType =
  | 'proposal.created'
  | 'proposal.auto_approved'
  | 'proposal.blocked'
  | 'proposal.approved'
  | 'proposal.rejected'
  | 'proposal.executed'
  | 'proposal.failed'
  | 'policy.updated'
  | 'agent.run_started'
  | 'agent.run_finished';

export type AuditEntry = {
  seq: number;
  ts: string;
  type: AuditEventType;
  proposalId?: string;
  actor: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export type ChainVerification = {
  ok: boolean;
  length: number;
  /** Sequence number of the first entry whose hash does not reconcile. */
  brokenAt?: number;
  message: string;
};
