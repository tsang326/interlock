import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk';
import { config, paypalConfigured } from '../config.js';
import type { ActionKind } from '../core/types.js';

/**
 * The only module in Interlock that can reach PayPal.
 *
 * Reads are open to the agent: they return information and move nothing. Writes are
 * reachable only through `executeApproved`, which the HTTP layer calls after a
 * proposal has cleared policy or a human. The agent has no path to this method.
 */

/** Tools the agent may call itself. Each one is read-only at the PayPal API level. */
export const READ_ONLY_TOOLS = [
  'list_invoices',
  'get_invoice',
  'search_invoicing',
  'list_products',
  'show_product_details',
  'list_subscription_plans',
  'show_subscription_plan_details',
  'show_subscription_details',
  'get_order',
  'get_refund',
  'list_disputes',
  'get_dispute',
  'get_shipment_tracking',
  'list_transactions',
  'get_merchant_insights',
] as const;

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];

/**
 * Reads the toolkit has no tool for, so Interlock calls the REST API underneath it.
 *
 * `show_capture_details` is the one that matters. Interlock has to know what a capture
 * actually took before it lets a refund draw on it, and the toolkit exposes no way to
 * ask. `list_transactions` is the obvious substitute and is the wrong tool for the job:
 * PayPal's transaction search is not real-time, so a capture taken minutes ago is simply
 * absent from it. `GET /v2/payments/captures/{id}` answers immediately, and answers more
 * — the capture's own status says whether it has already been refunded, and the seller
 * breakdown says what the merchant actually received after fees.
 *
 * These are GETs on payment resources. They move nothing.
 */
export const REST_READS = ['show_capture_details'] as const;

/**
 * Everything the agent may read, whichever side of the toolkit it comes from. Interlock
 * had no business knowing what a capture is worth while refusing to let the agent ask
 * the same question: an agent that cannot see a capture guesses at it instead.
 */
export const READABLE: readonly string[] = [...READ_ONLY_TOOLS, ...REST_READS];

/**
 * Reads that are allow-listed but cannot answer from this deployment, with the reason.
 *
 * Measured against this app's own sandbox credentials on 2026-10-20 by calling all
 * sixteen: fourteen answer, and these two cannot. `get_shipment_tracking` needs a scope
 * this app was never granted, so PayPal returns a 403 with no usable body at all;
 * `get_merchant_insights` is refused by the toolkit itself, before any request is made.
 *
 * The allow-list keeps both. A live deployment with the scope granted can call them, and
 * a caller that asks for one here should be told why it cannot answer rather than handed
 * a bare gateway error. What changes is what Interlock advertises: the count on screen and
 * the catalogue the agent reads come from `callableReads()`, because a read a reviewer can
 * click and watch fail is worth less than one fewer read.
 */
export const UNAVAILABLE_IN_SANDBOX: Readonly<Record<string, string>> = {
  get_shipment_tracking:
    'this app holds no shipping-tracking scope, so PayPal refuses the call (HTTP 403)',
  get_merchant_insights:
    'the PayPal toolkit refuses it outside live mode: not supported in sandbox',
};

/** Everything a caller can actually get an answer from, here, now. */
export function callableReads(): readonly string[] {
  if (!config.paypal.sandbox) return READABLE;
  return READABLE.filter((name) => !(name in UNAVAILABLE_IN_SANDBOX));
}

/** Why a read cannot answer from this deployment, or undefined if it can. */
export function unavailableReason(name: string): string | undefined {
  if (!config.paypal.sandbox) return undefined;
  return UNAVAILABLE_IN_SANDBOX[name];
}

const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const LIVE_API = 'https://api-m.paypal.com';

type ToolkitTool = {
  description: string;
  parameters: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
  execute: (args: unknown) => Promise<unknown>;
};

/** What `Interlock` needs. Lets the decision path be tested without touching PayPal. */
export interface Executor {
  readonly live: boolean;
  validate(name: string, params: unknown): { ok: true } | { ok: false; error: string };
  executeApproved(kind: ActionKind, params: unknown): Promise<unknown>;
  /**
   * A read-only call. Interlock uses these to check a proposal against what PayPal
   * actually holds, which is the only place some of the facts exist.
   */
  read(name: string, params: unknown): Promise<unknown>;
}

export class PayPalExecutor implements Executor {
  private tools: Record<string, ToolkitTool> | undefined;
  private token?: { value: string; expiresAt: number };

  constructor() {
    if (!paypalConfigured) return;
    const toolkit = new PayPalAgentToolkit({
      clientId: config.paypal.clientId!,
      clientSecret: config.paypal.clientSecret!,
      configuration: {
        actions: ALL_TOOLS_ENABLED,
        context: { sandbox: config.paypal.sandbox },
      },
    });
    this.tools = toolkit.getTools() as unknown as Record<string, ToolkitTool>;
  }

  get live(): boolean {
    return this.tools !== undefined;
  }

  describe(name: string): string | undefined {
    if (name === 'show_capture_details') {
      return 'Show a captured payment by its capture id. Returns what was captured, whether it has already been refunded, and what the merchant received after fees. Needs { id }. Use this rather than list_transactions to look up a payment: transaction search is not real-time and will not show a recent capture.';
    }
    return this.tools?.[name]?.description?.trim();
  }

  /**
   * Checks params against PayPal's own schema before a proposal is queued, so a
   * malformed action is rejected while it is still cheap rather than at execution.
   */
  validate(name: string, params: unknown): { ok: true } | { ok: false; error: string } {
    const tool = this.tools?.[name];
    if (!tool) return { ok: true }; // nothing to validate against in simulated mode
    const result = tool.parameters.safeParse(params);
    if (result.success) return { ok: true };
    return { ok: false, error: summarizeZodError(result.error) };
  }

  /** Read-only passthrough, for the agent and for Interlock's own verification layer. */
  async read(name: string, params: unknown): Promise<unknown> {
    if (REST_READS.includes(name as (typeof REST_READS)[number])) {
      return this.restRead(name, params);
    }
    if (!READ_ONLY_TOOLS.includes(name as ReadOnlyTool)) {
      throw new Error(`${name} is not a read-only tool`);
    }
    const tool = this.tools?.[name];
    if (!tool) throw new Error('PayPal credentials are not configured, so nothing can be read.');
    return assertSucceeded(normalize(await tool.execute(params)));
  }

  /** An OAuth token, reused until shortly before PayPal stops honouring it. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (!paypalConfigured) {
      throw new Error('PayPal credentials are not configured, so nothing can be read.');
    }
    const basic = Buffer.from(
      `${config.paypal.clientId}:${config.paypal.clientSecret}`,
    ).toString('base64');
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new Error(`PayPal refused to issue a token (HTTP ${response.status}).`);
    }
    // A minute of headroom, so a token never expires mid-lookup.
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 600) - 60) * 1000,
    };
    return this.token.value;
  }

  private get baseUrl(): string {
    return config.paypal.sandbox ? SANDBOX_API : LIVE_API;
  }

  private async restRead(name: string, params: unknown): Promise<unknown> {
    const id = (params as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${name} needs an id.`);
    // Path-segment only; an id that could escape the path is refused rather than sent.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${id} is not a PayPal resource id.`);

    const response = await fetch(`${this.baseUrl}/v2/payments/captures/${id}`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = (body as { name?: string; message?: string }) ?? {};
      throw new PayPalCallFailed(
        [detail.name, detail.message, `HTTP ${response.status}`].filter(Boolean).join(' \u2014 '),
        body,
      );
    }
    return body;
  }

  /**
   * Performs the money-moving call. Reached only from the approval path.
   * Throws on failure so the caller records `failed` rather than a silent success.
   */
  async executeApproved(kind: ActionKind, params: unknown): Promise<unknown> {
    const tool = this.tools?.[kind];
    if (!tool) {
      return {
        simulated: true,
        note: 'PayPal credentials not configured; nothing was sent to PayPal.',
        kind,
        params,
      };
    }
    return assertSucceeded(normalize(await tool.execute(params)));
  }
}

/** Several toolkit tools return a JSON string rather than an object. */
function normalize(result: unknown): unknown {
  if (typeof result !== 'string') return result;
  try {
    return JSON.parse(result);
  } catch {
    return { raw: result };
  }
}

export class PayPalCallFailed extends Error {
  constructor(
    message: string,
    public readonly response: unknown,
  ) {
    super(message);
  }
}

/**
 * The toolkit never throws. Every tool call is wrapped in a `try/catch` that resolves
 * with a JSON string, so a failure arrives looking like a return value. Taking one for
 * success would write "executed" into the audit trail for money that never moved, which
 * is the one lie this system must not tell.
 *
 * There are two shapes, and both must be caught:
 *
 *   `{ok: false, status, code, message}`   an HTTP error PayPal answered with
 *   `{error: {message, type}}`             the catch-all: anything else that threw
 *
 * The second has no `ok` and no `status`, so a check for those alone passes it through.
 * It covers a malformed payload, a connection that died before PayPal replied, and the
 * toolkit's own internal guards — every failure that is not an HTTP response.
 */
export function assertSucceeded(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;

  // Shape two: a nested error object, with no success flag anywhere to contradict it.
  const nested = r.error;
  if (nested && typeof nested === 'object') {
    const e = nested as Record<string, unknown>;
    const detail = [e.type, e.message].filter((p) => typeof p === 'string').join(' — ');
    throw new PayPalCallFailed(detail || 'The PayPal toolkit returned an error.', result);
  }
  if (typeof nested === 'string' && nested.length > 0) {
    throw new PayPalCallFailed(nested, result);
  }

  // Shape one: an HTTP error PayPal itself answered with.
  const status = typeof r.status === 'number' ? r.status : undefined;
  const failed = r.ok === false || (status !== undefined && status >= 400);
  if (!failed) return result;

  const detail = [r.code, r.message, r.name, status !== undefined ? `HTTP ${status}` : undefined]
    .filter((part): part is string | number => part !== undefined && part !== null)
    .join(' — ');
  throw new PayPalCallFailed(detail || 'PayPal rejected the call.', result);
}

/**
 * Best-effort "what did PayPal actually create" for the review UI, pulled from the
 * several shapes the toolkit returns.
 */
export function resourceRef(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  for (const key of ['id', 'invoice_id', 'capture_id', 'subscription_id', 'dispute_id']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  if (typeof r.href === 'string') {
    const tail = r.href.split('/').pop();
    if (tail) return tail;
  }
  return undefined;
}

function summarizeZodError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues)) return 'Parameters rejected by the PayPal schema.';
  return issues
    .slice(0, 4)
    .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
    .join('; ');
}
