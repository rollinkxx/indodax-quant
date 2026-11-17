import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ALL = Object.freeze({ deploy: true, relay: true, strategy: true });
const NONE = Object.freeze({ deploy: false, relay: false, strategy: false });

function anyMatch(files, pattern) {
  return files.some((file) => pattern.test(file));
}

/** Pure change classifier so release selection can be unit-tested without GitHub. */
export function classifyCiChanges(eventName, baseSha, changedFiles = []) {
  if (eventName === 'workflow_dispatch') return { ...ALL };
  if (eventName === 'pull_request') return { ...NONE };
  if (!baseSha || /^0+$/.test(baseSha)) return { ...ALL };

  const files = changedFiles.filter((file) => typeof file === 'string' && file.length > 0);
  const deploy = anyMatch(files, /^(worker\/|shared\/|src\/|public\/|index[.]html$|wrangler[.]jsonc$|vite[.]config[.]ts$|tsconfig([.][a-z]+)?[.]json$|package[.]json$|package-lock[.]json$|scripts\/smoke-production[.]ts$)/);
  // Every Worker deployment refreshes its relay-signing secret; redeploy the Supabase relay in the same release.
  // CI workflow edits also trigger a relay sync so orchestration changes are verified immediately.
  const relay = anyMatch(files, /^supabase\/functions\/indodax-proxy\//) || files.includes('scripts/smoke-production.ts') || files.includes('scripts/smoke-relay.ts') || deploy || files.includes('.github/workflows/ci-deploy.yml');
  const strategy = anyMatch(files, /^(worker\/|shared\/|supabase\/migrations\/|scripts\/(backtest[.]ts|backtest-history[.]ts|backtest-execution[.]ts|paper-report[.]ts|write-evaluation-summary[.]mjs)$|package[.]json$|package-lock[.]json$)/);
  return { deploy, relay, strategy };
}

function run() {
  const eventName = process.env.EVENT_NAME ?? '';
  const baseSha = process.env.BASE_SHA ?? '';
  const headSha = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? '';
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');

  let files = [];
  if (eventName === 'push' && baseSha && !/^0+$/.test(baseSha)) {
    files = execFileSync('git', ['diff', '--name-only', baseSha, headSha], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  }
  const flags = classifyCiChanges(eventName, baseSha, files);
  console.log('CI change classification:', JSON.stringify({ ...flags, changedFiles: files.length }));
  for (const [key, value] of Object.entries(flags)) {
    appendFileSync(outputPath, key + '=' + String(value) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
