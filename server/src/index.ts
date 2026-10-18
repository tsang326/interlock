import { anthropicConfigured, config, paypalConfigured } from './config.js';
import { Store } from './core/db.js';
import { seedDefaultRules } from './core/policy.js';
import { Warden } from './core/warden.js';
import { createApi } from './http/api.js';
import { PayPalExecutor } from './paypal/executor.js';

const store = new Store(config.dbFile);
seedDefaultRules(store);

const paypal = new PayPalExecutor();
const warden = new Warden(store, paypal);
const app = createApi(store, warden, paypal);

app.listen(config.port, () => {
  console.log(`Warden listening on :${config.port}`);
  console.log(`  PayPal     ${paypalConfigured ? (config.paypal.sandbox ? 'sandbox' : 'LIVE') : 'simulated'}`);
  console.log(`  Risk model ${anthropicConfigured ? config.anthropic.model : 'heuristics only'}`);
  console.log(`  Database   ${config.dbFile}`);
});
