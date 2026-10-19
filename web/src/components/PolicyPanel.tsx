import { useEffect, useState } from 'react';
import { api, type Rule } from '../lib/api';

const DECISION_LABEL: Record<Rule['then'], string> = {
  auto_approve: 'runs without asking',
  needs_review: 'waits for a human',
  block: 'is refused outright',
};

function describe(when: Record<string, unknown>): string {
  const parts: string[] = [];
  const kinds = when.kinds as string[] | undefined;
  if (kinds?.length) parts.push(`action is ${kinds.join(' or ')}`);
  if (when.amountGte !== undefined) parts.push(`amount ≥ ${when.amountGte}`);
  if (when.amountLt !== undefined) parts.push(`amount < ${when.amountLt}`);
  if (when.currency) parts.push(`currency is ${when.currency}`);
  if (when.riskScoreGte !== undefined) parts.push(`risk ≥ ${when.riskScoreGte}`);
  if (when.counterpartyUnseen === true) parts.push('counterparty never seen before');
  if (when.counterpartyUnseen === false) parts.push('counterparty seen before');
  const velocity = when.velocity as { countGte: number; windowMinutes: number } | undefined;
  if (velocity) parts.push(`${velocity.countGte}+ of these in ${velocity.windowMinutes} min`);
  return parts.length > 0 ? parts.join(' and ') : 'always';
}

export function PolicyPanel({ onError }: { onError: (m: string) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.rules().then(setRules).catch((e) => onError(String(e.message ?? e)));
  }, [onError]);

  const save = async (rule: Rule) => {
    setBusy(rule.id);
    try {
      const saved = await api.saveRule(rule);
      setRules((current) => current.map((r) => (r.id === saved.id ? saved : r)));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="scroll">
      <div className="hint" style={{ marginBottom: 10 }}>
        Rules run top to bottom and the first match decides. Anything no rule matches waits for a
        human — Interlock never falls through to execution.
      </div>

      {rules.map((rule) => (
        <div className="card" key={rule.id}>
          <div className="head">
            <b>{rule.name}</b>
            <span className="mono" style={{ color: 'var(--muted)' }}>
              #{rule.priority}
            </span>
            <span className="spacer" />
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={busy === rule.id}
                style={{ width: 'auto' }}
                onChange={(e) => save({ ...rule, enabled: e.target.checked })}
              />
              enabled
            </label>
          </div>

          <div style={{ fontSize: 13 }}>
            When <b>{describe(rule.when)}</b> → the action{' '}
            <b
              style={{
                color:
                  rule.then === 'block'
                    ? 'var(--danger)'
                    : rule.then === 'auto_approve'
                      ? 'var(--ok)'
                      : 'var(--warn)',
              }}
            >
              {DECISION_LABEL[rule.then]}
            </b>
            .
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {rule.reason}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <span className="hint">Outcome</span>
            <select
              value={rule.then}
              disabled={busy === rule.id}
              style={{ width: 200 }}
              onChange={(e) => save({ ...rule, then: e.target.value as Rule['then'] })}
            >
              <option value="auto_approve">auto_approve</option>
              <option value="needs_review">needs_review</option>
              <option value="block">block</option>
            </select>
            {rule.when.amountGte !== undefined && (
              <>
                <span className="hint">Threshold</span>
                <input
                  type="number"
                  defaultValue={rule.when.amountGte as number}
                  disabled={busy === rule.id}
                  style={{ width: 120 }}
                  onBlur={(e) =>
                    save({ ...rule, when: { ...rule.when, amountGte: Number(e.target.value) } })
                  }
                />
              </>
            )}
            {rule.when.riskScoreGte !== undefined && (
              <>
                <span className="hint">Risk ≥</span>
                <input
                  type="number"
                  defaultValue={rule.when.riskScoreGte as number}
                  disabled={busy === rule.id}
                  style={{ width: 90 }}
                  onBlur={(e) =>
                    save({ ...rule, when: { ...rule.when, riskScoreGte: Number(e.target.value) } })
                  }
                />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
