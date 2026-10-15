#!/usr/bin/env node
// Refuses to pass while any commissioning value in the Wrangler configs is still a placeholder.
// Run before every deploy of the deployer or the root runner: `npm run check:config`.
import { readFileSync, existsSync } from 'node:fs';

const files = ['wrangler.jsonc', 'wrangler.root-runner.jsonc'].filter((f) => existsSync(f));
const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const problems = [];

for (const file of files) {
  const config = JSON.parse(stripComments(readFileSync(file, 'utf8')));
  const vars = config.vars ?? {};
  if (!/^[1-9][0-9]*$/.test(vars.GITHUB_APP_ID ?? '')) problems.push(`${file}: vars.GITHUB_APP_ID is not set`);
  for (const [name, value] of Object.entries(vars)) {
    if (name.endsWith('_TOKEN_ID') && !/^[a-f0-9]{32}$/.test(String(value))) problems.push(`${file}: vars.${name} is not a token id`);
  }
  for (const kv of config.kv_namespaces ?? []) {
    if (!/^[a-f0-9]{32}$/.test(kv.id ?? '')) problems.push(`${file}: kv namespace ${kv.binding} id is not set`);
  }
  if (config.workers_dev !== false || config.preview_urls !== false) problems.push(`${file}: workers_dev and preview_urls must be false`);
  if ((config.routes ?? []).length > 0 || config.route) problems.push(`${file}: routes belong to infra, not here`);
}

if (problems.length) {
  console.error(`commissioning incomplete:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`config ready: ${files.join(', ')}`);
