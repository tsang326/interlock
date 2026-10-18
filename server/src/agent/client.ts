import { config } from '../config.js';

/**
 * The agent's entire reach.
 *
 * It holds a Warden token and nothing else — no PayPal client id, no secret, no
 * database handle. It reads PayPal because Warden will make a read on its behalf, and
 * it moves money by asking, never by doing. If this file were the only thing an
 * attacker controlled, the worst available outcome would be a queue of refused
 * proposals.
 */
export class WardenClient {
  constructor(
    private baseUrl = process.env.WARDEN_URL ?? `http://localhost:${config.port}`,
    private token = process.env.WARDEN_AGENT_TOKEN ?? 'demo-agent-token',
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: 'unreadable_response', detail: text.slice(0, 200) };
    }
    if (!response.ok) {
      // Handed back rather than thrown: a refusal is information the agent should see
      // and reason about, not a crash. A 403 here is the system working.
      return { ...(parsed as object), httpStatus: response.status };
    }
    return parsed;
  }

  readPayPal(tool: string, params: Record<string, unknown>): Promise<unknown> {
    return this.call('/api/paypal/read', { tool, params });
  }

  propose(body: Record<string, unknown>): Promise<unknown> {
    return this.call('/api/proposals', body);
  }

  async getProposal(id: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/api/proposals/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return response.json();
  }
}
