import { useEffect, useRef, useState } from 'react';
import { api, runAgent, type AgentStep, type Task } from '../lib/api';

/**
 * Watching the agent work.
 *
 * The queue shows what Warden decided; this shows who asked and why. A reviewer looking
 * at a held refund should be able to see the customer message it came from, every PayPal
 * call the agent made on the way, and what the agent told the merchant afterwards.
 */

type Props = { onProposals: (ids: string[]) => void; onError: (message: string) => void };

function preview(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The agent writes for a person, so its summary arrives as Markdown. Rendering the
 * handful of marks it actually uses is cheaper and safer than a Markdown library, and
 * nothing here interprets HTML: every piece of the text goes in as a text node.
 */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const bullet = /^\s*[-*]\s+/.test(line);
        const body = bullet ? line.replace(/^\s*[-*]\s+/, '') : line;
        const parts = body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
        const rendered = parts.map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <b key={j}>{part.slice(2, -2)}</b>
          ) : (
            <span key={j}>{part}</span>
          ),
        );
        if (line.trim() === '') return <div key={i} style={{ height: 8 }} />;
        return (
          <div key={i} className={bullet ? 'rich-bullet' : undefined}>
            {rendered}
          </div>
        );
      })}
    </>
  );
}

/** The PayPal call or the proposal, pulled out of the tool input for the step line. */
function stepLabel(step: Extract<AgentStep, { type: 'tool' }>): string {
  const input = step.input as { tool?: string; kind?: string };
  if (step.name === 'paypal_read' && input.tool) return `read PayPal · ${input.tool}`;
  if (step.name === 'propose_action' && input.kind) return `propose · ${input.kind}`;
  return step.name;
}

export function AgentPanel({ onProposals, onError }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [available, setAvailable] = useState(true);
  const [openId, setOpenId] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [summary, setSummary] = useState<string>();
  const [proposalIds, setProposalIds] = useState<string[]>([]);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .agentInbox()
      .then(({ tasks: inbox, available: ok }) => {
        setTasks(inbox);
        setAvailable(ok);
        setOpenId(inbox[0]?.id);
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  }, [onError]);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [steps.length, summary]);

  const run = async (task: Task) => {
    setRunning(task.id);
    setOpenId(task.id);
    setSteps([]);
    setSummary(undefined);
    setProposalIds([]);
    try {
      await runAgent(task.id, (event) => {
        if (event.type === 'step') setSteps((current) => [...current, event.step]);
        else if (event.type === 'done') {
          setSummary(event.summary);
          setProposalIds(event.proposalIds);
          onProposals(event.proposalIds);
        } else onError(event.detail);
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(undefined);
    }
  };

  return (
    <div className="scroll">
      <div className="hint" style={{ marginBottom: 10 }}>
        The agent holds a Warden token and nothing else. It can read PayPal through Warden
        and file proposals; it cannot execute, approve or change a rule, because the routes
        that do those things refuse its token. Everything below is one run, live.
        {!available && (
          <>
            {' '}
            <b style={{ color: 'var(--warn)' }}>
              No ANTHROPIC_API_KEY is set, so the agent cannot run. Warden itself does not
              need one.
            </b>
          </>
        )}
      </div>

      {tasks.map((task) => {
        const open = openId === task.id;
        const busy = running === task.id;
        return (
          <div className="card" key={task.id}>
            <div className="head">
              <b>{task.subject}</b>
              <span className="spacer" />
              <button
                onClick={() => setOpenId(open ? undefined : task.id)}
                style={{ width: 'auto' }}
              >
                {open ? 'hide' : 'show'}
              </button>
              <button
                className="primary"
                style={{ width: 'auto' }}
                disabled={!available || running !== undefined}
                onClick={() => void run(task)}
              >
                {busy ? 'running…' : 'Run agent'}
              </button>
            </div>
            <div className="hint">
              from {task.from} — {task.note}
            </div>

            {open && (
              <>
                <pre className="mono inbox-body">{task.body}</pre>

                {busy || (steps.length > 0 && openId === task.id) ? (
                  <div className="trace">
                    {(summary ? steps.filter((s) => s.type !== 'text') : steps).map((step, i) =>
                      step.type === 'tool' ? (
                        <div className="trace-row" key={i}>
                          <span className="trace-arrow">→</span>
                          <b>{stepLabel(step)}</b>
                          <span className="mono">{preview(step.input)}</span>
                        </div>
                      ) : step.type === 'result' ? (
                        <div className="trace-row muted" key={i}>
                          <span className="trace-arrow">←</span>
                          <span className="mono">{preview(step.output)}</span>
                        </div>
                      ) : (
                        <div className="trace-row think" key={i}>
                          {step.text}
                        </div>
                      ),
                    )}
                    {busy && <div className="trace-row muted">working…</div>}
                    <div ref={tail} />
                  </div>
                ) : null}

                {summary && openId === task.id && (
                  <div className="callout ok agent-summary" style={{ marginTop: 10 }}>
                    <Rich text={summary} />
                  </div>
                )}

                {proposalIds.length > 0 && openId === task.id && (
                  <div className="hint" style={{ marginTop: 8 }}>
                    Filed {proposalIds.length} proposal{proposalIds.length > 1 ? 's' : ''}:{' '}
                    <span className="mono">{proposalIds.join(', ')}</span>. They are in the
                    review queue with whatever Warden decided.
                  </div>
                )}
                {summary && proposalIds.length === 0 && openId === task.id && (
                  <div className="hint" style={{ marginTop: 8 }}>
                    The agent filed nothing, so Warden was never asked to decide anything.
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
