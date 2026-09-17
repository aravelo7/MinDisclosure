'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {loadFixture} = require('./md-bench-v0.2');
const {
  DEEPSEEK_RESPONSES_URL,
  DeepSeekResponsesAdapter,
  RealClock,
  TRANSPORT_CONTRACT,
  buildManifest,
  buildPreparedRuns,
  canonicalJson,
  classifyAttempt,
  executePreparedRun,
  executeWithRetry,
  scanSecrets,
  sha256,
  withSelfHash
} = require('./llm-experiment');

const ROOT = path.resolve(__dirname, '..');
const SMOKE_ID = 'engineering-smoke-api-v0.1';
const OUTPUT_ROOT = path.join(ROOT, 'artifacts', 'llm', 'engineering-smoke-v0.1');
const CANARY_SCHEMA = {
  type: 'object',
  properties: {ok: {type: 'boolean'}},
  required: ['ok'],
  additionalProperties: false
};

function providerSnapshot() {
  return withSelfHash({
    provider: 'DeepSeek',
    provider_docs_checked_at: new Date().toISOString(),
    requested_model: 'deepseek-flash',
    documented_serving_model: 'DeepSeek-V4.1-Flash',
    responses_endpoint: DEEPSEEK_RESPONSES_URL,
    alias_routing_change_detected: false,
    sources: [
      'https://api-docs.deepseek.com/guides/responses_api/',
      'https://api-docs.deepseek.com/quick_start/pricing/',
      'https://api-docs.deepseek.com/updates/'
    ],
    snapshot_note: 'Official docs still map deepseek-flash to DeepSeek-V4.1-Flash; recheck before formal execution.'
  }, 'snapshot_sha256');
}

function buildCanaryRequest() {
  return {
    model: 'deepseek-flash',
    instructions: 'Return only the requested structured result.',
    input: 'Return {"ok": true}.',
    reasoning: {effort: 'none'},
    temperature: 0,
    max_output_tokens: 256,
    stream: false,
    text: {format: {type: 'json_schema', name: 'min_disclosure_transport_canary_v0_1', schema: CANARY_SCHEMA}}
  };
}

function requestPreflight() {
  const fixture = loadFixture();
  const manifest = buildManifest({experimentId: 'engineering-smoke-preflight-v0.1'});
  const prepared = buildPreparedRuns(fixture, manifest);
  const selected = prepared.find((item) => item.run.task_id === 'MD-EQ-01' &&
    item.run.strategy === 'STABLE_TOKENIZATION' && item.run.repetition_index === 1);
  if (!selected) throw new Error('PREFLIGHT_CASE_NOT_FOUND');
  const request = selected.request;
  const forbiddenKeys = ['top_p', 'tools', 'tool_choice', 'user'];
  const forbiddenText = ['STABLE_TOKENIZATION', 'OPAQUE_TOKEN', 'exposure_weight', 'ground_truth',
    'oracle_disclosure_plan', 'task_requirements', 'agent_ledger'];
  const serialized = canonicalJson(request);
  const checks = {
    model: request.model === 'deepseek-flash',
    reasoning_none: canonicalJson(request.reasoning) === canonicalJson({effort: 'none'}),
    temperature_zero: request.temperature === 0,
    max_output_tokens_256: request.max_output_tokens === 256,
    stream_false: request.stream === false,
    json_schema: request.text?.format?.type === 'json_schema',
    omitted_fields: forbiddenKeys.every((key) => !Object.hasOwn(request, key)),
    no_strategy_or_hidden_metadata: forbiddenText.every((value) => !serialized.includes(value)),
    secret_scan_zero: scanSecrets(request).length === 0,
    request_hash_reproducible: sha256(request) === sha256(JSON.parse(serialized))
  };
  return {passed: Object.values(checks).every(Boolean), checks, request_sha256: sha256(request), request,
    selected_case: {task_id: selected.run.task_id, strategy: selected.run.strategy,
      repetition_index: selected.run.repetition_index}};
}

function smokeFlags() {
  return {execution_type: 'engineering_smoke', research_result: false, included_in_formal_evaluation: false};
}

function writeJson(name, value) {
  fs.mkdirSync(OUTPUT_ROOT, {recursive: true});
  fs.writeFileSync(path.join(OUTPUT_ROOT, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function runSmokeA(adapter, snapshot) {
  const request = buildCanaryRequest();
  const execution = await executeWithRetry({
    request,
    provider: adapter,
    runId: 'smoke-a',
    classify: (attempt) => classifyAttempt(attempt, 'SMOKE-A', CANARY_SCHEMA),
    contract: TRANSPORT_CONTRACT,
    clock: new RealClock()
  });
  const classification = execution.classification;
  const last = execution.attempts.at(-1);
  const artifact = {
    experiment_id: SMOKE_ID,
    smoke: 'A',
    ...smokeFlags(),
    provider_snapshot_sha256: snapshot.snapshot_sha256,
    requested_model: request.model,
    returned_model: last.response?.model ?? null,
    request,
    request_sha256: execution.request_hash,
    http_status: last.http_status ?? null,
    provider_status: last.response?.status ?? null,
    response_id: last.response?.id ?? null,
    status: classification.status,
    parsed_output: classification.parsed_output ?? null,
    schema_status: classification.schema_status ?? 'not_evaluated',
    schema_error: classification.schema_error ?? null,
    usage: last.response?.usage ?? null,
    latency_ms: execution.wall_time_ms,
    attempt_count: execution.attempts.length,
    retry_count: execution.attempts.length - 1,
    retry_wait_ms: execution.retry_wait_ms,
    attempts: execution.attempts
  };
  return withSelfHash(artifact, 'artifact_sha256');
}

async function runSmokeB(adapter, snapshot) {
  const fixture = loadFixture();
  const manifest = buildManifest({experimentId: 'engineering-smoke-v0.1'});
  const prepared = buildPreparedRuns(fixture, manifest);
  const selected = prepared.find((item) => item.run.task_id === 'MD-EQ-01' &&
    item.run.strategy === 'STABLE_TOKENIZATION' && item.run.repetition_index === 1);
  if (!selected) throw new Error('SMOKE_B_CASE_NOT_FOUND');
  const result = await executePreparedRun(selected, adapter, fixture, manifest, {clock: new RealClock()});
  return withSelfHash({...result, ...smokeFlags(), smoke: 'B',
    provider_snapshot_sha256: snapshot.snapshot_sha256}, 'artifact_sha256');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--preflight', '--run'].includes(args[0])) {
    throw new Error('usage: node src/run-deepseek-smoke.js --preflight|--run');
  }
  const preflight = requestPreflight();
  if (!preflight.passed) throw new Error('OFFLINE_PREFLIGHT_FAILED');
  if (args[0] === '--preflight') {
    process.stdout.write(`${JSON.stringify({mode: 'offline_preflight', ...preflight})}\n`);
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('MISSING_DEEPSEEK_API_KEY: live smoke not dispatched');

  const snapshot = providerSnapshot();
  const adapter = new DeepSeekResponsesAdapter();
  writeJson('provider-snapshot.json', snapshot);
  const smokeA = await runSmokeA(adapter, snapshot);
  writeJson('smoke-a.json', smokeA);
  const smokeASuccess = smokeA.http_status === 200 && smokeA.provider_status === 'completed' &&
    smokeA.schema_status === 'valid';
  if (!smokeASuccess) {
    const summary = withSelfHash({experiment_id: 'engineering-smoke-v0.1', ...smokeFlags(),
      preflight: {passed: true, request_sha256: preflight.request_sha256}, smoke_a: smokeA.status,
      smoke_b: 'NOT_RUN_SMOKE_A_FAILED', actual_http_dispatches: adapter.dispatch_count,
      secret_scan_matches: scanSecrets({snapshot, smokeA})}, 'summary_sha256');
    writeJson('summary.json', summary);
    throw new Error(`SMOKE_A_FAILED:${smokeA.status}`);
  }

  const smokeB = await runSmokeB(adapter, snapshot);
  writeJson('smoke-b.json', smokeB);
  const summary = withSelfHash({experiment_id: 'engineering-smoke-v0.1', ...smokeFlags(),
    preflight: {passed: true, request_sha256: preflight.request_sha256},
    smoke_a: smokeA.status, smoke_b: smokeB.status,
    actual_http_dispatches: adapter.dispatch_count,
    recorded_attempts: smokeA.attempt_count + smokeB.attempt_count,
    secret_scan_matches: scanSecrets({snapshot, smokeA, smokeB})}, 'summary_sha256');
  writeJson('summary.json', summary);
  if (summary.actual_http_dispatches !== summary.recorded_attempts) throw new Error('DISPATCH_ACCOUNTING_MISMATCH');
  process.stdout.write(`${JSON.stringify({output: OUTPUT_ROOT, summary})}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {CANARY_SCHEMA, OUTPUT_ROOT, SMOKE_ID, buildCanaryRequest, providerSnapshot,
  requestPreflight, runSmokeA, runSmokeB};
