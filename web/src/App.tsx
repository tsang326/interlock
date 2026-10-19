import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { AuditPanel } from './components/AuditPanel';
import { PolicyPanel } from './components/PolicyPanel';
import { ProposalDetail } from './components/ProposalDetail';
import { ReviewQueue } from './components/ReviewQueue';
import {
  api,
  getToken,
  setToken,
  subscribeToEvents,
  type Health,
  type Proposal,
  type ProposalStatus,
} from './lib/api';

type Tab = 'queue' | 'agent' | 'policy' | 'audit';
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
  const [token, setTokenState] = useState(getToken());
  const [tokenDraft, setTokenDraft] = useState('');

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
    if (token) void load();
  }, [load, token]);

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
        await (action === 'approve' ? api.approve(id, note) : api.reject(id, note));
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
          Interlock <span>approval layer for agent payments</span>
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
          {token && (
            <button
              className="linkish"
              onClick={() => {
                setToken('');
                setTokenState('');
                setTokenDraft('');
              }}
            >
              sign out
            </button>
          )}
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>
          Review queue
          {pendingCount > 0 && <span className="count">{pendingCount}</span>}
        </button>
        <button className={`tab ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}>
          Agent
        </button>
        <button className={`tab ${tab === 'policy' ? 'active' : ''}`} onClick={() => setTab('policy')}>
          Policy
        </button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit
        </button>
      </nav>

      {!token && (
        <div className="signin">
          <div>
            <b>Sign in to review</b>
            <p>
              Interlock answers nothing without a token, and the token decides what you may do.
              An agent's token can file proposals but never approve them. The demo tokens are
              in the project README.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setToken(tokenDraft.trim());
                setTokenState(tokenDraft.trim());
              }}
            >
              <input
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="demo-reviewer-token"
                autoFocus
              />
              <button className="primary" type="submit">
                Use this token
              </button>
            </form>
          </div>
        </div>
      )}

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

          {tab === 'agent' && (
            <AgentPanel
              onError={showError}
              onProposals={(ids) => {
                // A run that filed something should leave the reviewer one click from it.
                void load();
                if (ids[0]) setSelectedId(ids[0]);
              }}
            />
          )}
          {tab === 'policy' && <PolicyPanel onError={showError} />}
          {tab === 'audit' && (
            <AuditPanel onError={showError} tamperAvailable={health?.demoTamperAvailable ?? false} />
          )}
        </div>

        {tab === 'queue' && (
          <ProposalDetail
            proposal={selected}
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
