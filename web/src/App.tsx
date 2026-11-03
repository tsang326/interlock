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
  const [guideOpen, setGuideOpen] = useState(() => {
    try {
      return localStorage.getItem('interlock-guide') !== 'closed';
    } catch {
      return true;
    }
  });
  const closeGuide = () => {
    setGuideOpen(false);
    try {
      localStorage.setItem('interlock-guide', 'closed');
    } catch {
      /* private mode: the guide just comes back next visit */
    }
  };
  const signIn = (value: string) => {
    setToken(value);
    setTokenState(value);
  };

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

  // The panel is a quarter of the window and opened empty, so the first thing a visitor
  // saw there was a line telling them to click something. Open the top proposal instead;
  // a reviewer who selects another one is not overridden, because this only fires while
  // nothing is selected.
  useEffect(() => {
    if (!selectedId && proposals[0]) setSelectedId(proposals[0].id);
  }, [proposals, selectedId]);

  // Said once above the grid rather than on every row. True of the public demo, where the
  // seeded queue is scored without the model; the first agent-filed proposal clears it.
  const modelOff = proposals.length > 0 && proposals.every((p) => p.risk.modelScore === undefined);

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
          {/* Only worth a line of its own when the two jobs are not on the same model. */}
          {health?.agentModel && health.agentModel !== health.riskModel && (
            <div>
              Agent model <b>{health.agentModel}</b>
            </div>
          )}
          <div>
            Gated actions <b>{health?.gatedActions ?? '—'}</b>
          </div>
          <div
            title={
              health?.readsUnavailableHere?.length
                ? `${health.readsAllowListed} reads are allow-listed; ${health.readsUnavailableHere.join(
                    ' and ',
                  )} cannot answer in the sandbox, so they are not offered.`
                : undefined
            }
          >
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
            {health?.usingDemoTokens && (
              <button className="primary demo-signin" onClick={() => signIn('demo-reviewer-token')}>
                Use the demo reviewer token
              </button>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                signIn(tokenDraft.trim());
              }}
            >
              <input
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="demo-reviewer-token"
                autoFocus
              />
              <button className={health?.usingDemoTokens ? '' : 'primary'} type="submit">
                Use this token
              </button>
            </form>
          </div>
        </div>
      )}

      {token && guideOpen && tab === 'queue' && (
        <section className="guide" aria-label="Start here">
          <b>Start here</b>
          <ol>
            <li>
              <button className="linkish" onClick={() => setTab('agent')}>Agent</button>: run{' '}
              <i>"Re: your invoice — automated reply"</i>. The customer mail hides instructions for the
              agent. Watch what it proposes.
            </li>
            <li>
              <button className="linkish" onClick={() => setTab('queue')}>Review queue</button>: open
              the proposal it filed. Interlock held it, and shows what PayPal itself says next to what
              the agent claimed.
            </li>
            <li>
              <button className="linkish" onClick={() => setTab('audit')}>Audit</button>: verify the
              hash chain, tamper with it, verify again, then undo the tamper.
            </li>
          </ol>
          <button className="linkish close" onClick={closeGuide} aria-label="Hide the guide">
            hide
          </button>
        </section>
      )}

      <div className="main">
        <div className="content">
          {tab === 'queue' && (
            <ReviewQueue
              proposals={proposals}
              modelOff={modelOff}
              selectedId={selectedId}
              onSelect={(p) => setSelectedId(p.id)}
              onSelectionChange={setCheckedIds}
              trailing={
                <button onClick={() => void load()} disabled={busy}>
                  Refresh
                </button>
              }
              leading={
                <>
                  <div className="chips" role="group" aria-label="Filter by status">
                    {(['pending', 'blocked', 'executed', 'all'] as Filter[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`chip${filter === f ? ' on' : ''}`}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
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
                </>
              }
            />
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
