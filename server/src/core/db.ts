import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  AuditEntry,
  AuditEventType,
  ChainVerification,
  Proposal,
  ProposalStatus,
  Rule,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  params        TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  amount_value  REAL,
  amount_currency TEXT,
  amount_status TEXT NOT NULL DEFAULT 'unverifiable',
  counterparty  TEXT,
  counterparty_status TEXT NOT NULL DEFAULT 'unverifiable',
  counterparty_kind TEXT,
  declared_amount_value REAL,
  declared_amount_currency TEXT,
  declared_counterparty TEXT,
  fact_notes    TEXT NOT NULL DEFAULT '[]',
  mismatches    TEXT NOT NULL DEFAULT '[]',
  verification  TEXT NOT NULL DEFAULT '{"status":"not_applicable","findings":[]}',
  status        TEXT NOT NULL,
  risk          TEXT NOT NULL,
  policy        TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  result        TEXT,
  error         TEXT,
  executed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_kind_created ON proposals(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_counterparty ON proposals(counterparty);

CREATE TABLE IF NOT EXISTS rules (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  enabled  INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  when_json TEXT NOT NULL,
  then_decision TEXT NOT NULL,
  reason   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  proposal_id TEXT,
  actor       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
`;

const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical JSON: object keys sorted at every depth, so the same logical payload
 * always hashes identically regardless of insertion order.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  const preimage = canonical({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    proposalId: e.proposalId ?? null,
    actor: e.actor,
    payload: e.payload,
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(preimage).digest('hex');
}

type ProposalRow = {
  id: string;
  created_at: string;
  kind: string;
  params: string;
  rationale: string;
  session_id: string;
  amount_value: number | null;
  amount_currency: string | null;
  amount_status: string;
  counterparty: string | null;
  counterparty_status: string;
  counterparty_kind: string | null;
  declared_amount_value: number | null;
  declared_amount_currency: string | null;
  declared_counterparty: string | null;
  fact_notes: string;
  mismatches: string;
  verification: string;
  status: string;
  risk: string;
  policy: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result: string | null;
  error: string | null;
  executed_at: string | null;
};

function rowToProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    createdAt: r.created_at,
    kind: r.kind as Proposal['kind'],
    params: JSON.parse(r.params),
    rationale: r.rationale,
    sessionId: r.session_id,
    amount:
      r.amount_value === null || r.amount_currency === null
        ? undefined
        : { value: r.amount_value, currency: r.amount_currency },
    amountStatus: r.amount_status as Proposal['amountStatus'],
    counterparty: r.counterparty ?? undefined,
    counterpartyStatus: r.counterparty_status as Proposal['counterpartyStatus'],
    counterpartyKind: (r.counterparty_kind ?? undefined) as Proposal['counterpartyKind'],
    declaredAmount:
      r.declared_amount_value === null || r.declared_amount_currency === null
        ? undefined
        : { value: r.declared_amount_value, currency: r.declared_amount_currency },
    declaredCounterparty: r.declared_counterparty ?? undefined,
    factNotes: JSON.parse(r.fact_notes),
    mismatches: JSON.parse(r.mismatches),
    verification: JSON.parse(r.verification),
    status: r.status as ProposalStatus,
    risk: JSON.parse(r.risk),
    policy: JSON.parse(r.policy),
    decidedBy: r.decided_by ?? undefined,
    decidedAt: r.decided_at ?? undefined,
    decisionNote: r.decision_note ?? undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
    error: r.error ?? undefined,
    executedAt: r.executed_at ?? undefined,
  };
}

export class Store {
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a column added
   * after someone already has a database would never appear. Each migration is a
   * column add that is safe to attempt twice.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!columns.has('verification')) {
      this.db.exec(
        `ALTER TABLE proposals ADD COLUMN verification TEXT NOT NULL DEFAULT '{"status":"not_applicable","findings":[]}'`,
      );
    }
  }

  /* ---------- audit chain ---------- */

  /**
   * Appends one entry, chaining it to the current tip. The seq/prev_hash read and
   * the insert share a transaction so two concurrent appends cannot fork the chain.
   */
  append(
    type: AuditEventType,
    actor: string,
    payload: Record<string, unknown>,
    proposalId?: string,
  ): AuditEntry {
    const tx = this.db.transaction((): AuditEntry => {
      const tip = this.db
        .prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined;

      const entry: Omit<AuditEntry, 'hash'> = {
        seq: (tip?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        type,
        proposalId,
        actor,
        payload,
        prevHash: tip?.hash ?? GENESIS_HASH,
      };
      const hash = hashEntry(entry);

      this.db
        .prepare(
          `INSERT INTO audit (seq, ts, type, proposal_id, actor, payload, prev_hash, hash)
           VALUES (@seq, @ts, @type, @proposalId, @actor, @payload, @prevHash, @hash)`,
        )
        .run({
          seq: entry.seq,
          ts: entry.ts,
          type: entry.type,
          proposalId: entry.proposalId ?? null,
          actor: entry.actor,
          payload: JSON.stringify(entry.payload),
          prevHash: entry.prevHash,
          hash,
        });

      return { ...entry, hash };
    });
    return tx();
  }

  auditEntries(limit = 500): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?')
      .all(limit) as Array<Record<string, any>>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      proposalId: r.proposal_id ?? undefined,
      actor: r.actor,
      payload: JSON.parse(r.payload),
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  /** Recomputes every hash from the genesis entry forward. */
  verifyChain(): ChainVerification {
    const rows = this.db
      .prepare('SELECT * FROM audit ORDER BY seq ASC')
      .all() as Array<Record<string, any>>;

    let prevHash = GENESIS_HASH;
    for (const [i, r] of rows.entries()) {
      if (r.seq !== i + 1) {
        return {
          ok: false,
          length: rows.length,
          brokenAt: r.seq,
          message: `Sequence gap at ${r.seq}: an entry was deleted.`,
        };
      }
      if (r.prev_hash !== prevHash) {
        return {
          ok: false,
          length: rows.length,
          brokenAt: r.seq,
          message: `Entry ${r.seq} does not link to the previous entry.`,
        };
      }
      const expected = hashEntry({
        seq: r.seq,
        ts: r.ts,
        type: r.type,
        proposalId: r.proposal_id ?? undefined,
        actor: r.actor,
        payload: JSON.parse(r.payload),
        prevHash: r.prev_hash,
      });
      if (expected !== r.hash) {
        return {
          ok: false,
          length: rows.length,
          brokenAt: r.seq,
          message: `Entry ${r.seq} was modified after it was written.`,
        };
      }
      prevHash = r.hash;
    }
    return {
      ok: true,
      length: rows.length,
      message:
        rows.length === 0
          ? 'Chain is empty.'
          : `All ${rows.length} entries verified; tip ${prevHash.slice(0, 12)}.`,
    };
  }

  /* ---------- proposals ---------- */

  insertProposal(p: Proposal): void {
    this.db
      .prepare(
        `INSERT INTO proposals (
           id, created_at, kind, params, rationale, session_id,
           amount_value, amount_currency, amount_status,
           counterparty, counterparty_status, counterparty_kind,
           declared_amount_value, declared_amount_currency, declared_counterparty,
           fact_notes, mismatches, verification, status, risk, policy
         ) VALUES (
           @id, @createdAt, @kind, @params, @rationale, @sessionId,
           @amountValue, @amountCurrency, @amountStatus,
           @counterparty, @counterpartyStatus, @counterpartyKind,
           @declaredAmountValue, @declaredAmountCurrency, @declaredCounterparty,
           @factNotes, @mismatches, @verification, @status, @risk, @policy
         )`,
      )
      .run({
        id: p.id,
        createdAt: p.createdAt,
        kind: p.kind,
        params: JSON.stringify(p.params),
        rationale: p.rationale,
        sessionId: p.sessionId,
        amountValue: p.amount?.value ?? null,
        amountCurrency: p.amount?.currency ?? null,
        amountStatus: p.amountStatus,
        counterparty: p.counterparty ?? null,
        counterpartyStatus: p.counterpartyStatus,
        counterpartyKind: p.counterpartyKind ?? null,
        declaredAmountValue: p.declaredAmount?.value ?? null,
        declaredAmountCurrency: p.declaredAmount?.currency ?? null,
        declaredCounterparty: p.declaredCounterparty ?? null,
        factNotes: JSON.stringify(p.factNotes),
        mismatches: JSON.stringify(p.mismatches),
        verification: JSON.stringify(p.verification),
        status: p.status,
        risk: JSON.stringify(p.risk),
        policy: JSON.stringify(p.policy),
      });
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  listProposals(opts: { status?: ProposalStatus; limit?: number } = {}): Proposal[] {
    const limit = opts.limit ?? 500;
    const rows = opts.status
      ? (this.db
          .prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(opts.status, limit) as ProposalRow[])
      : (this.db
          .prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?')
          .all(limit) as ProposalRow[]);
    return rows.map(rowToProposal);
  }

  updateProposal(
    id: string,
    patch: Partial<
      Pick<
        Proposal,
        | 'status'
        | 'decidedBy'
        | 'decidedAt'
        | 'decisionNote'
        | 'result'
        | 'error'
        | 'executedAt'
        | 'risk'
        | 'policy'
      >
    >,
  ): void {
    const sets: string[] = [];
    const bind: Record<string, unknown> = { id };
    const put = (col: string, key: string, value: unknown) => {
      sets.push(`${col} = @${key}`);
      bind[key] = value;
    };
    if (patch.status !== undefined) put('status', 'status', patch.status);
    if (patch.decidedBy !== undefined) put('decided_by', 'decidedBy', patch.decidedBy);
    if (patch.decidedAt !== undefined) put('decided_at', 'decidedAt', patch.decidedAt);
    if (patch.decisionNote !== undefined) put('decision_note', 'decisionNote', patch.decisionNote);
    if (patch.result !== undefined) put('result', 'result', JSON.stringify(patch.result));
    if (patch.error !== undefined) put('error', 'error', patch.error);
    if (patch.executedAt !== undefined) put('executed_at', 'executedAt', patch.executedAt);
    if (patch.risk !== undefined) put('risk', 'risk', JSON.stringify(patch.risk));
    if (patch.policy !== undefined) put('policy', 'policy', JSON.stringify(patch.policy));
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = @id`).run(bind);
  }

  /**
   * Count of proposals of one kind in the window before `before`; drives velocity rules.
   *
   * The window is anchored to the proposal being judged rather than to the clock, so the
   * question is the one the rule actually asks — "were there five of these in the ten
   * minutes before this one" — and it gets the same answer however long the row has been
   * sitting in the queue. Anchoring to `Date.now()` instead made a seeded demo queue read
   * as one giant burst, which blocked the next honest refund for ten minutes.
   */
  countRecentByKind(kind: string, windowMinutes: number, before: string): number {
    const since = new Date(new Date(before).getTime() - windowMinutes * 60_000).toISOString();
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM proposals WHERE kind = ? AND created_at >= ? AND created_at < ?',
      )
      .get(kind, since, before) as { n: number };
    return row.n;
  }

  /** True when this counterparty has never had a proposal execute. */
  isCounterpartyUnseen(counterparty: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM proposals WHERE counterparty = ? AND status = 'executed'",
      )
      .get(counterparty) as { n: number };
    return row.n === 0;
  }

  /* ---------- rules ---------- */

  listRules(): Rule[] {
    const rows = this.db
      .prepare('SELECT * FROM rules ORDER BY priority ASC')
      .all() as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled === 1,
      priority: r.priority,
      when: JSON.parse(r.when_json),
      then: r.then_decision,
      reason: r.reason,
    }));
  }

  upsertRule(rule: Rule): void {
    this.db
      .prepare(
        `INSERT INTO rules (id, name, enabled, priority, when_json, then_decision, reason)
         VALUES (@id, @name, @enabled, @priority, @when, @then, @reason)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, enabled = @enabled, priority = @priority,
           when_json = @when, then_decision = @then, reason = @reason`,
      )
      .run({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled ? 1 : 0,
        priority: rule.priority,
        when: JSON.stringify(rule.when),
        then: rule.then,
        reason: rule.reason,
      });
  }

  /**
   * Demo affordance: edits one entry in place so a viewer can watch the chain catch it.
   * This is the only write in the system that bypasses `append`, and it exists so the
   * tamper-evidence claim can be seen rather than taken on trust.
   */
  demoTamper(): { seq: number; field: string } | undefined {
    const row = this.db
      .prepare("SELECT seq, payload FROM audit WHERE type != 'policy.updated' ORDER BY seq ASC LIMIT 1 OFFSET 1")
      .get() as { seq: number; payload: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.amount = { value: 1, currency: 'USD' };
    payload.tamperedBy = 'demo';
    this.db.prepare('UPDATE audit SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq);
    return { seq: row.seq, field: 'payload.amount' };
  }

  countRules(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
  }
}
