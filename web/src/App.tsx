import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuditPanel } from './components/AuditPanel';
import { PolicyPanel } from './components/PolicyPanel';
import { ProposalDetail } from './components/ProposalDetail';
import { ReviewQueue } from './components/ReviewQueue';
import { api, subscribeToEvents, type Health, type Proposal, type ProposalStatus } from './lib/api';

type Tab = 'queue' | 'policy' | 'audit';
type Filter = 'pending' | 'all' | 'blocked' | 'executed';

const FILTER_STATUS: Record<Filter, ProposalStatus | undefined> = {
  pending: 'pending',
  blocked: 'blocked',
  executed: 'executed',
  all: undefined,
};

export default function App() {
  const [tab, setTab] = useState<Tab>('queue');
  const [filter, setFilter] = useState<Filter>('pending');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [health, setHealth] = useState<Health>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reviewer = 'sang';

  const showError = useCallback((message: string) => {
    setError(message);
    setTimeout(() => setError(undefined), 6000);
  }, []);

  const load = useCallback(async () => {
    try {
      setProposals(await api.proposals(FILTER_STATUS[filter]));
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }, [filter, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.health().then(setHealth).catch(() => undefined);
  }, []);

  // The queue must move on its own: an agent can file a proposal at any moment.
  useEffect(() => subscribeToEvents(() => void load()), [load]);

  const selected = useMemo(
    () => proposals.find((p) => p.id === selectedId),
    [proposals, selectedId],
  );

  const pendingCount = useMemo(
    () => proposals.filter((p) => p.status === 'pending').length,
    [proposals],
  );

  const decide = async (action: 'approve' | 'reject', ids: string[], note: string) => {
    setBusy(true);
    try {
      for (const id of ids) {
        await (action === 'approve' ? api.approve(id, reviewer, note) : api.reject(id, reviewer, note));
      }
      await load();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkedPending = checkedIds.filter(
    (id) => proposals.find((p) => p.id === id)?.status === 'pending',
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Warden <span>approval layer for agent payments</span>
        </div>
        <div className="statusline">
          <div>
            PayPal <b>{health?.paypal ?? '…'}</b>
          </div>
          <div>
            Risk model <b>{health?.riskModel ?? 'heuristics only'}</b>
          </div>
          <div>
            Gated actions <b>{health?.gatedActions ?? '—'}</b>
          </div>
          <div>
            Agent-callable reads <b>{health?.readOnlyTools ?? '—'}</b>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>
          Review queue
          {pendingCount > 0 && <span className="count">{pendingCount}</span>}
        </button>
        <button className={`tab ${tab === 'policy' ? 'active' : ''}`} onClick={() => setTab('policy')}>
          Policy
        </button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit
        </button>
      </nav>

      <div className="main">
        <div className="content">
          {tab === 'queue' && (
            <>
              <div className="toolbar">
                {(['pending', 'blocked', 'executed', 'all'] as Filter[]).map((f) => (
                  <button
                    key={f}
                    className={filter === f ? 'primary' : ''}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
                <span className="spacer" />
                {checkedPending.length > 0 && (
                  <>
                    <span className="hint">{checkedPending.length} selected</span>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void decide('approve', checkedPending, 'bulk approve')}
                    >
                      Approve selected
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => void decide('reject', checkedPending, 'bulk reject')}
                    >
                      Reject selected
                    </button>
                  </>
                )}
                <button onClick={() => void load()} disabled={busy}>
                  Refresh
                </button>
              </div>
              <ReviewQueue
                proposals={proposals}
                selectedId={selectedId}
                onSelect={(p) => setSelectedId(p.id)}
                onSelectionChange={setCheckedIds}
              />
            </>
          )}

          {tab === 'policy' && <PolicyPanel reviewer={reviewer} onError={showError} />}
          {tab === 'audit' && (
            <AuditPanel onError={showError} tamperAvailable={health?.demoTamperAvailable ?? false} />
          )}
        </div>

        {tab === 'queue' && (
          <ProposalDetail
            proposal={selected}
            reviewer={reviewer}
            busy={busy}
            onApprove={(id, note) => void decide('approve', [id], note)}
            onReject={(id, note) => void decide('reject', [id], note)}
          />
        )}
      </div>

      {error && <div className="toast">{error}</div>}
    </div>
  );
}
