import { useCallback, useEffect, useState } from 'react';
import { api, type AuditEntry, type ChainVerification } from '../lib/api';

export function AuditPanel({
  onError,
  tamperAvailable,
}: {
  onError: (message: string) => void;
  tamperAvailable: boolean;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chain, setChain] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await api.audit(300));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const tamper = async () => {
    try {
      const result = await api.demoTamper();
      setChain(result.verification);
      await load();
      onError(`Entry ${result.edited.seq} was edited directly in the database — now verify.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const restore = async () => {
    try {
      const result = await api.demoRestore();
      setChain(result.verification);
      await load();
      onError(
        result.restored.length
          ? `Entry ${result.restored.join(', ')} restored to what it held before the tamper.`
          : 'Nothing to restore: the demo tamper has not been used.',
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      setChain(await api.verifyChain());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="scroll">
      <div className="card">
        <div className="head">
          <b>Tamper-evident log</b>
          <span className="spacer" />
          <button onClick={() => void load()}>Refresh</button>
          {tamperAvailable && (
            <button className="danger" onClick={() => void tamper()}>
              Tamper with the log
            </button>
          )}
          {tamperAvailable && chain && !chain.ok && (
            <button onClick={() => void restore()}>Undo the tamper</button>
          )}
          <button className="primary" onClick={verify} disabled={verifying}>
            {verifying ? 'Verifying…' : 'Verify chain'}
          </button>
        </div>
        <div className="hint">
          Every decision is appended carrying the SHA-256 hash of the entry before it, so each
          row is bound to the whole history behind it. Edit or remove a row and every hash after
          it stops reconciling; the check below walks the chain from the first entry and names
          the first break. This makes the log <b>tamper-evident</b>, not tamper-proof: the hashes
          are unkeyed, and removing entries from the end leaves a shorter chain that still
          reconciles. Anchoring the tip outside the database is the fix, and is not built yet.
        </div>
        {chain && (
          <div className={`callout ${chain.ok ? 'ok' : 'danger'}`} style={{ marginTop: 10 }}>
            <b>{chain.ok ? 'Intact' : `Broken at entry ${chain.brokenAt}`}</b>
            <div style={{ marginTop: 4 }}>{chain.message}</div>
          </div>
        )}
      </div>

      <div className="card">
        <table className="audit">
          <thead>
            <tr>
              <th style={{ width: 52 }}>#</th>
              <th style={{ width: 170 }}>When</th>
              <th style={{ width: 170 }}>Event</th>
              <th style={{ width: 150 }}>Actor</th>
              <th>Detail</th>
              <th style={{ width: 96 }}>Links to</th>
              <th style={{ width: 96 }}>Hash</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.seq}>
                <td className="mono">{entry.seq}</td>
                <td className="mono">{new Date(entry.ts).toLocaleString()}</td>
                <td className="mono">{entry.type}</td>
                <td className="mono">{entry.actor}</td>
                <td className="mono audit-detail" title={JSON.stringify(entry.payload)}>
                  {summarise(entry.payload)}
                </td>
                <td className="mono" style={{ color: 'var(--muted)' }}>
                  {entry.prevHash === '0'.repeat(64) ? 'genesis' : `${entry.prevHash.slice(0, 8)}…`}
                </td>
                <td className="mono" style={{ color: 'var(--muted)' }}>
                  {entry.hash.slice(0, 8)}…
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: 'var(--muted)', padding: 16 }}>
                  Nothing logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A raw JSON dump cut at a fixed length ended mid-token on most rows -- `"declaredAmount":
 * {"value":74.5,"cur` -- which reads as a broken field rather than a shortened one. Show
 * the entry's own fields as key=value instead, and keep the full JSON in the title.
 */
function summarise(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload !== 'object') return String(payload);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    let text: string;
    if (value === null || value === undefined) text = '—';
    else if (typeof value === 'object') {
      const inner = value as Record<string, unknown>;
      // Money arrives as {value, currency}; anything else is named, not spelled out.
      text =
        'value' in inner
          ? `${inner.value}${inner.currency ? ` ${inner.currency}` : ''}`
          : Array.isArray(value)
            ? `${value.length} item${value.length === 1 ? '' : 's'}`
            : '{…}';
    } else text = String(value);
    if (text.length > 60) text = `${text.slice(0, 59)}…`;
    parts.push(`${key} ${text}`);
  }
  return parts.join('  ·  ');
}
