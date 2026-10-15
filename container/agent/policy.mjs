import { JobFailure } from './errors.mjs';

/**
 * Parses `conftest test --output json` into `[{ rule, result, messages }]`. Conftest reports
 * failures, warnings and exceptions individually and passing rules only as a count, so passes are
 * one aggregate entry. A rule is named by `metadata.details.rule` when the policy returns
 * structured results, else by a `P1:`-style prefix of the message.
 */

const MAX_RULES = 200;
const MAX_MESSAGES = 50;
const MAX_MESSAGE = 1000;
const RULE = /^[A-Za-z0-9_.:*-]{1,80}$/;
const SEVERITY = { fail: 4, exception: 3, warn: 2, skip: 1, pass: 0 };

function ruleOf(item) {
  const declared = item?.metadata?.details?.rule;
  if (typeof declared === 'string' && RULE.test(declared)) return declared;
  const prefix = /^([A-Za-z][A-Za-z0-9_.-]{0,40}):\s/.exec(String(item?.msg ?? ''));
  return prefix ? prefix[1] : 'unnamed';
}

function clean(text) {
  const s = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
}

export function parseConftestOutput(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new JobFailure('policy_error', 'conftest output is not JSON');
  }
  if (!Array.isArray(doc)) throw new JobFailure('policy_error', 'conftest output is not a list of results');
  const rules = new Map();
  let passes = 0;
  const add = (item, result) => {
    const rule = ruleOf(item);
    const entry = rules.get(rule) ?? { rule, result: 'pass', messages: [] };
    if (SEVERITY[result] > SEVERITY[entry.result]) entry.result = result;
    if (entry.messages.length < MAX_MESSAGES) entry.messages.push(clean(item?.msg));
    rules.set(rule, entry);
  };
  for (const file of doc) {
    if (file === null || typeof file !== 'object') throw new JobFailure('policy_error', 'conftest result entry is malformed');
    passes += Number.isSafeInteger(file.successes) ? file.successes : 0;
    for (const item of file.failures ?? []) add(item, 'fail');
    for (const item of file.exceptions ?? []) add(item, 'exception');
    for (const item of file.warnings ?? []) add(item, 'warn');
    for (const item of file.skipped ?? []) add(item, 'skip');
  }
  // A policy directory whose rules were never evaluated (wrong namespace, empty directory) would
  // otherwise read as a pass. Nothing evaluated is an error, never an approval.
  const evaluated = passes + doc.reduce((n, f) => n + (f.failures?.length ?? 0) + (f.exceptions?.length ?? 0) + (f.warnings?.length ?? 0), 0);
  if (evaluated === 0) throw new JobFailure('policy_error', 'conftest evaluated no policy rule');
  const results = [...rules.values()].sort((a, b) => SEVERITY[b.result] - SEVERITY[a.result] || a.rule.localeCompare(b.rule)).slice(0, MAX_RULES - 1);
  if (passes > 0) results.push({ rule: '*', result: 'pass', messages: [`${passes} policy checks passed`] });
  // Exceptions are denials a policy explicitly excused; only failures fail the plan.
  return { results, passed: !results.some((r) => r.result === 'fail') };
}
