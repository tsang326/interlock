import 'dotenv/config';

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
  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    model: process.env.WARDEN_MODEL ?? 'claude-opus-5-5',
  },
  auth: {
    // Demo defaults so a judge can run the project without inventing secrets. A real
    // deployment sets both; `WARDEN_REQUIRE_TOKENS=true` refuses to start without them.
    agentToken: process.env.WARDEN_AGENT_TOKEN ?? 'demo-agent-token',
    reviewerToken: process.env.WARDEN_REVIEWER_TOKEN ?? 'demo-reviewer-token',
    reviewerName: process.env.WARDEN_REVIEWER_NAME ?? 'demo-reviewer',
    requireConfigured: process.env.WARDEN_REQUIRE_TOKENS === 'true',
  },
  port: Number(process.env.PORT ?? 8787),
  dbFile: process.env.WARDEN_DB ?? './warden.sqlite',
};

/** True when real PayPal calls are possible; otherwise approved actions are simulated. */
export const paypalConfigured = Boolean(config.paypal.clientId && config.paypal.clientSecret);

/** True when risk scoring can use the model; otherwise it falls back to heuristics. */
export const anthropicConfigured = Boolean(config.anthropic.apiKey);

/** True when the tokens are still the published demo values. */
export const usingDemoTokens =
  config.auth.agentToken === 'demo-agent-token' ||
  config.auth.reviewerToken === 'demo-reviewer-token';
