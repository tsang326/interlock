import { config as loadEnv } from 'dotenv';

// The server runs from server/ under pnpm, but the README puts .env at the repo root: read both
loadEnv({ path: ['.env', '../.env'], quiet: true });

/** The model both jobs use unless one of them is pinned to something else. */
const DEFAULT_MODEL = 'gpt-4.1';

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  paypal: {
    clientId: optional('PAYPAL_CLIENT_ID'),
    clientSecret: optional('PAYPAL_CLIENT_SECRET'),
    sandbox: process.env.PAYPAL_SANDBOX !== 'false',
  },
  model: {
    apiKey: optional('OPENAI_API_KEY'),
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    // Two different jobs, so two settings. The agent is a multi-turn conversation that
    // has to hold its nerve against a prompt injection in a customer's own words; risk
    // scoring is one short structured call per proposal, and it is the one a development
    // loop re-runs for every proposal in the queue. INTERLOCK_MODEL moves both at once;
    // either job can be pinned on its own, and a cheaper model on one says nothing about
    // the other. What a substitution costs in findings is measurable — see the README.
    agentModel: process.env.INTERLOCK_AGENT_MODEL ?? process.env.INTERLOCK_MODEL ?? DEFAULT_MODEL,
    riskModel: process.env.INTERLOCK_RISK_MODEL ?? process.env.INTERLOCK_MODEL ?? DEFAULT_MODEL,
  },
  auth: {
    // Demo defaults so a judge can run the project without inventing secrets. A real
    // deployment sets both; `INTERLOCK_REQUIRE_TOKENS=true` refuses to start without them.
    agentToken: process.env.INTERLOCK_AGENT_TOKEN ?? 'demo-agent-token',
    reviewerToken: process.env.INTERLOCK_REVIEWER_TOKEN ?? 'demo-reviewer-token',
    reviewerName: process.env.INTERLOCK_REVIEWER_NAME ?? 'demo-reviewer',
    requireConfigured: process.env.INTERLOCK_REQUIRE_TOKENS === 'true',
  },
  agent: {
    // The agent is the only metered thing in here: one run is a multi-turn model
    // conversation. A published URL with published tokens is an open door to it, so the
    // number of runs this process will start is a hard ceiling rather than a hope.
    runBudget: Number(process.env.INTERLOCK_AGENT_RUN_BUDGET ?? 8),
    // The run ceiling refills, because a process that is kept awake never restarts and
    // a ceiling that never refills turns into a ceiling for the whole month: the
    // twenty-sixth person to press the button would be told the demo is spent. So the
    // runs are counted in a rolling window, and the thing that cannot refill is money.
    //
    // Six hours, not twenty-four. The tokens that reach this route are published in the
    // README, so anyone holding the URL can spend the whole allowance, and the number
    // that matters is not how much they can spend but how long the deployment stays
    // empty afterwards. A day-long window means a visitor who drains it at 02:00 leaves
    // the Agent tab answering 429 until 02:00 tomorrow; a six-hour one bounds that wait
    // to under six hours and costs nothing extra per day worth caring about. Money is
    // still held by the spend ceiling below, which does not refill at all.
    runBudgetWindowHours: Number(process.env.INTERLOCK_AGENT_RUN_WINDOW_HOURS ?? 6),
    // What the model calls behind those runs are allowed to cost, in US dollars, for
    // the life of this process. Runs are a proxy for spending; this is the spending.
    spendBudgetUsd: Number(process.env.INTERLOCK_AGENT_SPEND_USD ?? 4),
  },
  port: Number(process.env.PORT ?? 8787),
  dbFile: process.env.INTERLOCK_DB ?? './interlock.sqlite',
};

/** True when real PayPal calls are possible; otherwise approved actions are simulated. */
export const paypalConfigured = Boolean(config.paypal.clientId && config.paypal.clientSecret);

/** True when risk scoring can use the model; otherwise it falls back to heuristics. */
export const modelConfigured = Boolean(config.model.apiKey);

/** True when the tokens are still the published demo values. */
export const usingDemoTokens =
  config.auth.agentToken === 'demo-agent-token' ||
  config.auth.reviewerToken === 'demo-reviewer-token';
