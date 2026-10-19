/**
 * Runs the agent against the demo inbox.
 *
 * Interlock must already be running: the agent reaches it over HTTP with an agent token,
 * exactly as a third-party agent would. It does not import the decision path.
 *
 *   pnpm --filter @interlock/server agent          # every message
 *   pnpm --filter @interlock/server agent msg-5150 # one of them
 */
import { PayPalExecutor } from '../paypal/executor.js';
import { INBOX } from './inbox.js';
import { runAgent } from './run.js';
import { InterlockClient } from './client.js';

const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;

async function main() {
  const wanted = process.argv[2];
  const tasks = wanted ? INBOX.filter((t) => t.id === wanted) : INBOX;
  if (tasks.length === 0) {
    console.error(`No message ${wanted}. Known: ${INBOX.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  const paypal = new PayPalExecutor();
  const interlock = new InterlockClient();

  for (const task of tasks) {
    console.log(`\n${bold(task.subject)}`);
    console.log(dim(`from ${task.from} — ${task.note}`));
    console.log(dim('─'.repeat(78)));

    const run = await runAgent(task, paypal, (step) => {
      if (step.type === 'tool') {
        console.log(`  ${bold('→')} ${step.name} ${dim(JSON.stringify(step.input).slice(0, 150))}`);
      } else if (step.type === 'result') {
        console.log(`  ${dim('←')} ${dim(step.output.replace(/\s+/g, ' ').slice(0, 150))}`);
      }
    });

    console.log(`\n${run.summary}\n`);

    for (const id of run.proposalIds) {
      const p = (await interlock.getProposal(id)) as {
        kind: string;
        status: string;
        risk: { score: number };
        policy: { reason: string };
        verification: { status: string; findings: string[] };
      };
      console.log(`  ${bold(p.kind)} → ${bold(p.status)}  risk ${p.risk.score}`);
      console.log(`    ${p.policy.reason}`);
      console.log(dim(`    PayPal: ${p.verification.status}. ${p.verification.findings.join(' ')}`));
    }
    if (run.proposalIds.length === 0) console.log(dim('  No proposal was filed.'));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
