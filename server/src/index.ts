import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { modelConfigured, config, paypalConfigured } from './config.js';
import { Store } from './core/db.js';
import { seedDefaultRules } from './core/policy.js';
import { Interlock } from './core/interlock.js';
import { createApi } from './http/api.js';
import { PayPalExecutor } from './paypal/executor.js';
import { seedDemo } from './seed.js';

const store = new Store(config.dbFile);
seedDefaultRules(store);

const paypal = new PayPalExecutor();
const interlock = new Interlock(store, paypal);
const app = createApi(store, interlock, paypal);

/**
 * In production the API also serves the console, so the whole thing is one service and
 * one origin — no CORS, no second deployment, and the console cannot end up pointing at
 * an API that has moved.
 *
 * The static handler goes on after the API routes, and the fallback is a middleware
 * rather than a wildcard route so it cannot swallow an unmatched `/api/...` and answer
 * a missing endpoint with the index page.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
const consoleBuilt = existsSync(path.join(webDist, 'index.html'));

if (consoleBuilt) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

async function start(): Promise<void> {
  // A fresh deployment starts with an empty database and would show an empty queue,
  // which demonstrates nothing. Seeding only when it is empty means a restart never
  // duplicates the scenario, and never touches a queue someone has been working in.
  if (process.env.INTERLOCK_SEED_ON_BOOT !== 'false' && store.listProposals({ limit: 1 }).length === 0) {
    try {
      // Opt-in, not opt-out. Without a persistent disk this runs at every cold start,
      // and a stranger refreshing the page must not be able to spend the model budget.
      // Anything filed after boot — every agent run — is still scored by the model.
      await seedDemo(store, paypal, interlock, {
        useModel: process.env.INTERLOCK_SEED_MODEL === 'true',
      });
      console.log('  Seeded an empty database with the demo scenario.');
    } catch (error) {
      console.error('  Seeding failed; the queue starts empty.', error);
    }
  }

  app.listen(config.port, () => {
    console.log(`Interlock listening on :${config.port}`);
    console.log(`  PayPal     ${paypalConfigured ? (config.paypal.sandbox ? 'sandbox' : 'LIVE') : 'simulated'}`);
    console.log(`  Risk model ${modelConfigured ? config.model.riskModel : 'heuristics only'}`);
    console.log(`  Agent      ${modelConfigured ? config.model.agentModel : 'no key; runs are refused'}`);
    console.log(`  Database   ${config.dbFile}`);
    console.log(`  Console    ${consoleBuilt ? 'served from web/dist' : 'not built; run pnpm build'}`);
  });
}

void start();
