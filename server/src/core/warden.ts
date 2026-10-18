import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { resourceRef, type Executor } from '../paypal/executor.js';
import type { Store } from './db.js';
import { deriveFacts, findMismatches } from './derive.js';
import { evaluatePolicy, type PolicyFacts } from './policy.js';
import { assessRisk } from './risk.js';
import type { Proposal, ProposalInput } from './types.js';

export class SchemaRejection extends Error {
  constructor(public readonly detail: string) {
    super(`PayPal rejected these parameters: ${detail}`);
  }
}

export class InvalidTransition extends Error {}

type Listener = (event: { type: string; proposal?: Proposal }) => void;

/**
 * Orchestrates the one path a money-moving action may take:
 *
 *   submit -> score -> policy -> (execute | wait for a human | refuse)
 *
 * `execute` is private and runs only for a proposal already in `approved`. There is
 * no route from a proposal to PayPal that skips this file.
 */
export class Warden {
  private listeners = new Set<Listener>();

  constructor(
    private store: Store,
    private paypal: Executor,
  ) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: string, proposal?: Proposal): void {
    for (const fn of this.listeners) {
      try {
        fn({ type, proposal });
      } catch {
        // A broken subscriber must not break the decision path.
      }
    }
  }

  async submit(input: ProposalInput): Promise<Proposal> {
    const check = this.paypal.validate(input.kind, input.params);
    if (!check.ok) throw new SchemaRejection(check.error);

    // Everything downstream decides on these, never on what the agent said it was doing.
    const facts = deriveFacts(input.kind, input.params);
    const mismatches = findMismatches(facts, input.declaredAmount, input.declaredCounterparty);
    const subject: PolicyFacts = { kind: input.kind, facts, mismatches };

    const risk = await assessRisk(input, subject, this.store);
    const policy = evaluatePolicy(subject, risk, this.store);

    const proposal: Proposal = {
      ...input,
      id: `prop_${nanoid(12)}`,
      createdAt: new Date().toISOString(),
      amount: facts.amount,
      amountStatus: facts.amountStatus,
      counterparty: facts.counterparty,
      counterpartyStatus: facts.counterpartyStatus,
      counterpartyKind: facts.counterpartyKind,
      factNotes: facts.notes,
      mismatches,
      status:
        policy.decision === 'block'
          ? 'blocked'
          : policy.decision === 'auto_approve'
            ? 'approved'
            : 'pending',
      risk,
      policy,
    };

    this.store.insertProposal(proposal);
    this.store.append(
      'proposal.created',
      `agent:${input.sessionId}`,
      {
        kind: proposal.kind,
        amount: proposal.amount ?? null,
        amountStatus: proposal.amountStatus,
        counterparty: proposal.counterparty ?? null,
        declaredAmount: proposal.declaredAmount ?? null,
        mismatches: proposal.mismatches,
        paramsHash: hashParams(proposal.params),
        riskScore: risk.score,
        decision: policy.decision,
        matchedRules: policy.matchedRules,
      },
      proposal.id,
    );

    if (policy.decision === 'block') {
      this.store.append('proposal.blocked', 'warden', { reason: policy.reason }, proposal.id);
      this.emit('proposal.blocked', proposal);
      return proposal;
    }

    if (policy.decision === 'auto_approve') {
      this.store.append('proposal.auto_approved', 'warden', { reason: policy.reason }, proposal.id);
      this.emit('proposal.auto_approved', proposal);
      return this.execute(proposal.id);
    }

    this.emit('proposal.created', proposal);
    return proposal;
  }

  approve(id: string, by: string, note?: string): Promise<Proposal> {
    const proposal = this.require(id);
    if (proposal.status !== 'pending') {
      throw new InvalidTransition(`Proposal is ${proposal.status}, not pending.`);
    }
    this.store.updateProposal(id, {
      status: 'approved',
      decidedBy: by,
      decidedAt: new Date().toISOString(),
      decisionNote: note,
    });
    this.store.append('proposal.approved', by, { note: note ?? null }, id);
    return this.execute(id);
  }

  reject(id: string, by: string, note?: string): Proposal {
    const proposal = this.require(id);
    if (proposal.status !== 'pending') {
      throw new InvalidTransition(`Proposal is ${proposal.status}, not pending.`);
    }
    this.store.updateProposal(id, {
      status: 'rejected',
      decidedBy: by,
      decidedAt: new Date().toISOString(),
      decisionNote: note,
    });
    this.store.append('proposal.rejected', by, { note: note ?? null }, id);
    const updated = this.require(id);
    this.emit('proposal.rejected', updated);
    return updated;
  }

  /** The single call site for PayPal writes. Only an approved proposal reaches it. */
  private async execute(id: string): Promise<Proposal> {
    const proposal = this.require(id);
    if (proposal.status !== 'approved') {
      throw new InvalidTransition(`Refusing to execute a proposal in state ${proposal.status}.`);
    }

    try {
      const result = await this.paypal.executeApproved(proposal.kind, proposal.params);
      this.store.updateProposal(id, {
        status: 'executed',
        result,
        executedAt: new Date().toISOString(),
      });
      // Bind the entry to what was actually sent and what PayPal created, so the chain
      // proves not just that a decision happened but what it was about.
      this.store.append(
        'proposal.executed',
        'warden',
        {
          live: this.paypal.live,
          paramsHash: hashParams(proposal.params),
          resourceRef: resourceRef(result) ?? null,
        },
        id,
      );
      const updated = this.require(id);
      this.emit('proposal.executed', updated);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateProposal(id, { status: 'failed', error: message });
      this.store.append('proposal.failed', 'warden', { error: message }, id);
      const updated = this.require(id);
      this.emit('proposal.failed', updated);
      return updated;
    }
  }

  private require(id: string): Proposal {
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new InvalidTransition(`No proposal ${id}.`);
    return proposal;
  }
}

/**
 * Binds the audit entry to the exact bytes that were, or would have been, sent to PayPal.
 * Without this the chain proves a decision was made but not what it was made about.
 */
function hashParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
}
