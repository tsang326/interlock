import { useState } from 'react';
import type { Proposal } from '../lib/api';

/** Factor codes that should stand out: they describe an attack, not just a risk. */
const HOT = /inject|instruct|urgen|suppress|attack|pressure|mismatch|inconsist|suspicious/i;

type Props = {
  proposal?: Proposal;
  busy: boolean;
  onApprove: (id: string, note: string) => void;
  onReject: (id: string, note: string) => void;
};

export function ProposalDetail({ proposal, busy, onApprove, onReject }: Props) {
  const [note, setNote] = useState('');

  if (!proposal) {
    return (
      <aside className="drawer">
        <div className="empty">
          Select a proposal to see what the agent asked for,
          <br />
          and why Warden held it.
        </div>
      </aside>
    );
  }

  const decidable = proposal.status === 'pending';
  const band = proposal.risk.score >= 70 ? 'danger' : proposal.risk.score >= 40 ? 'warn' : 'ok';

  return (
    <aside className="drawer">
      <h2>{proposal.kind}</h2>
      <div className="mono" style={{ color: 'var(--muted)' }}>
        {proposal.id}
      </div>

      <h3>Decision</h3>
      <div className={`callout ${proposal.status === 'blocked' ? 'danger' : band}`}>
        <b className={`pill ${proposal.status}`}>{proposal.status}</b>
        <div style={{ marginTop: 6 }}>{proposal.policy.reason}</div>
        {proposal.policy.matchedRules.length > 0 && (
          <div className="mono" style={{ marginTop: 6, color: 'var(--muted)' }}>
            rule: {proposal.policy.matchedRules.join(', ')}
          </div>
        )}
      </div>

      <h3>What the agent said, and what the request does</h3>
      <div className={`callout ${proposal.mismatches.length > 0 ? 'danger' : 'ok'}`}>
        <dl className="compare">
          <dt>Agent stated</dt>
          <dd>
            {proposal.declaredAmount
              ? `${proposal.declaredAmount.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${proposal.declaredAmount.currency}`
              : 'nothing'}
          </dd>
          <dt>Request moves</dt>
          <dd>
            <b>
              {proposal.amount
                ? `${proposal.amount.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${proposal.amount.currency}`
                : 'cannot be determined'}
            </b>
          </dd>
        </dl>
        {proposal.mismatches.map((m) => (
          <div key={m} style={{ marginTop: 6 }}>
            {m}
          </div>
        ))}
        {proposal.factNotes.map((n) => (
          <div key={n} style={{ marginTop: 6, color: 'var(--muted)' }}>
            {n}
          </div>
        ))}
        {proposal.mismatches.length === 0 && proposal.factNotes.length === 0 && (
          <div style={{ color: 'var(--muted)' }}>
            Warden read the amount out of the request and the agent's account matched it.
          </div>
        )}
      </div>

      <h3>Risk {proposal.risk.score} / 100</h3>
      <div className="layers">
        <div>
          <span>Rules</span>
          <b>{proposal.risk.ruleScore}</b>
          <small>always score the same way</small>
        </div>
        <div>
          <span>Model</span>
          <b>{proposal.risk.modelScore ?? '—'}</b>
          <small>{proposal.risk.modelBacked ? 'read this request' : 'did not run'}</small>
        </div>
      </div>
      <div className={`callout ${band}`} style={{ marginTop: 8 }}>
        {proposal.risk.explanation}
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
          The model may raise the score. It can never lower what the rules set, and it can
          never approve anything.
        </div>
      </div>
      <div className="factors" style={{ marginTop: 8 }}>
        {proposal.risk.factors.map((factor) => (
          <span key={factor} className={HOT.test(factor) ? 'hot' : undefined}>
            {factor}
          </span>
        ))}
      </div>

      <h3>Facts</h3>
      <dl>
        <dt>Target in request</dt>
        <dd>
          {proposal.counterparty ?? 'unknown'}
          {proposal.counterpartyKind === 'resource_id' && (
            <span className="hint"> (PayPal resource)</span>
          )}
        </dd>
        <dt>Agent session</dt>
        <dd className="mono">{proposal.sessionId}</dd>
        <dt>Proposed</dt>
        <dd>{new Date(proposal.createdAt).toLocaleString()}</dd>
        {proposal.decidedBy && (
          <>
            <dt>Decided by</dt>
            <dd>
              {proposal.decidedBy}
              {proposal.decisionNote ? ` — ${proposal.decisionNote}` : ''}
            </dd>
          </>
        )}
        {proposal.resourceRef && (
          <>
            <dt>PayPal ref</dt>
            <dd className="mono">{proposal.resourceRef}</dd>
          </>
        )}
        {proposal.error && (
          <>
            <dt>Error</dt>
            <dd style={{ color: 'var(--danger)' }}>{proposal.error}</dd>
          </>
        )}
      </dl>

      <h3>Agent's rationale (untrusted)</h3>
      <div className="callout warn" style={{ whiteSpace: 'pre-wrap' }}>
        {proposal.rationale}
      </div>

      <h3>Parameters sent to PayPal</h3>
      <pre className="json">{JSON.stringify(proposal.params, null, 2)}</pre>

      {proposal.result !== undefined && (
        <>
          <h3>PayPal response</h3>
          <pre className="json">{JSON.stringify(proposal.result, null, 2)}</pre>
        </>
      )}

      {decidable && (
        <>
          <h3>Your decision</h3>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the audit trail (optional)"
          />
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                onApprove(proposal.id, note);
                setNote('');
              }}
            >
              Approve &amp; execute
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                onReject(proposal.id, note);
                setNote('');
              }}
            >
              Reject
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Approving calls PayPal immediately. The decision is recorded against whoever your
            token identifies — not a name typed into this page.
          </div>
        </>
      )}
    </aside>
  );
}
