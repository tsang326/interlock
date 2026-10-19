export type Decision = 'auto_approve' | 'needs_review' | 'block';

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'executed'
  | 'failed'
  | 'expired';

export type Proposal = {
  id: string;
  createdAt: string;
  kind: string;
  params: Record<string, unknown>;
  rationale: string;
  sessionId: string;
  /** What the agent claimed. Shown beside the derived figure, never used to decide. */
  declaredAmount?: { value: number; currency: string };
  declaredCounterparty?: string;
  /** Read out of the parameters that reach PayPal. This is what policy ran on. */
  amount?: { value: number; currency: string };
  amountStatus: 'derived' | 'unverifiable';
  counterparty?: string;
  counterpartyKind?: 'email' | 'resource_id';
  counterpartyStatus: 'derived' | 'unverifiable';
  factNotes: string[];
  mismatches: string[];
  /** What PayPal itself said about the resource, asked at proposal time. */
  verification: Verification;
  status: ProposalStatus;
  risk: {
    score: number;
    ruleScore: number;
    modelScore?: number;
    factors: string[];
    explanation: string;
    modelBacked: boolean;
  };
  policy: { decision: Decision; matchedRules: string[]; reason: string };
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: unknown;
  resourceRef?: string;
  error?: string;
  executedAt?: string;
};

export type Verification = {
  status: 'confirmed' | 'contradicted' | 'unavailable' | 'not_applicable';
  source?: string;
  amount?: { value: number; currency: string };
  resourceState?: string;
  findings: string[];
  error?: string;
};

export type Task = {
  id: string;
  from: string;
  subject: string;
  body: string;
  /** Why this message is in the demo. Shown to the operator; the agent never sees it. */
  note: string;
};

export type AgentStep =
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'result'; name: string; output: string }
  | { type: 'text'; text: string };

export type AgentEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'done'; summary: string; proposalIds: string[]; sessionId: string }
  | { type: 'error'; detail: string };

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  when: Record<string, unknown>;
  then: Decision;
  reason: string;
};

export type AuditEntry = {
  seq: number;
  ts: string;
  type: string;
  proposalId?: string;
  actor: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

export type Health = {
  ok: boolean;
  paypal: string;
  riskModel: string | null;
  readOnlyTools: number;
  gatedActions: number;
  demoTamperAvailable: boolean;
  usingDemoTokens: boolean;
  agentRuns: { started: number; budget: number };
};

export type ChainVerification = {
  ok: boolean;
  length: number;
  brokenAt?: number;
  message: string;
};

const TOKEN_KEY = 'interlock.token';

/**
 * The reviewer's token lives in this browser only. It is never sent anywhere except to
 * Interlock's own API, and the server decides who you are from it — the UI cannot assert
 * an identity of its own.
 */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A browser with storage disabled still works for one session.
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  proposals: (status?: ProposalStatus) =>
    request<Proposal[]>(`/api/proposals${status ? `?status=${status}` : ''}`),
  // No identity is sent: the server reads it from the token.
  approve: (id: string, note?: string) =>
    request<Proposal>(`/api/proposals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  reject: (id: string, note?: string) =>
    request<Proposal>(`/api/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  rules: () => request<Rule[]>('/api/rules'),
  saveRule: (rule: Rule) =>
    request<Rule>(`/api/rules/${rule.id}`, { method: 'PUT', body: JSON.stringify(rule) }),
  audit: (limit = 200) => request<AuditEntry[]>(`/api/audit?limit=${limit}`),
  verifyChain: () => request<ChainVerification>('/api/audit/verify'),
  agentInbox: () => request<{ tasks: Task[]; available: boolean }>('/api/agent/inbox'),
  demoTamper: () =>
    request<{ edited: { seq: number; field: string }; verification: ChainVerification }>(
      '/api/audit/demo-tamper',
      { method: 'POST' },
    ),
};

/**
 * Runs the agent on one inbox message, calling `onEvent` as each step arrives.
 *
 * The stream is newline-delimited JSON over a normal fetch rather than server-sent
 * events, because `EventSource` cannot carry an Authorization header and this route is
 * not going to be the second open one.
 */
export async function runAgent(
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const response = await fetch('/api/agent/run', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ taskId }),
  });
  if (!response.ok || !response.body) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? detail;
    } catch {
      // Nothing better than the status line.
    }
    throw new ApiError(response.status, detail);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    // A chunk can split a line, so only whole lines are parsed and the tail is kept.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent);
}

/** Subscribes to server-sent proposal events; returns an unsubscribe function. */
export function subscribeToEvents(onEvent: (type: string) => void): () => void {
  // EventSource cannot carry a header, so the stream is open; it emits decision events
  // but no proposal contents a reader could not already fetch.
  const source = new EventSource('/api/events');
  const types = [
    'proposal.created',
    'proposal.auto_approved',
    'proposal.blocked',
    'proposal.approved',
    'proposal.rejected',
    'proposal.executed',
    'proposal.failed',
  ];
  for (const type of types) source.addEventListener(type, () => onEvent(type));
  return () => source.close();
}
