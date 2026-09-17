'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {STRATEGIES, TASK_IDS} = require('../src/constants');
const {loadFixture} = require('../src/md-bench-v0.2');
const {
  DeepSeekResponsesAdapter,
  LATIN_ROWS,
  MAX_OUTPUT_TOKENS,
  TRANSPORT_CONTRACT,
  buildManifest,
  buildPreparedRuns,
  canonicalJson,
  deterministicOrder,
  parseRetryAfter,
  retryDecision,
  runMockExperiment,
  scanSecrets,
  sha256
} = require('../src/llm-experiment');

const fixture = loadFixture();
const manifest = buildManifest({benchmarkCommit: 'test-commit'});
const prepared = buildPreparedRuns(fixture, manifest);

function sameTask(taskId) {
  return prepared.filter((item) => item.run.task_id === taskId && item.run.repetition_index === 1);
}

test('contract freezes calibrated non-thinking request fields', () => {
  const request = prepared[0].request;
  assert.equal(request.model, 'deepseek-flash');
  assert.deepEqual(request.reasoning, {effort: 'none'});
  assert.equal(request.temperature, 0);
  assert.equal(request.max_output_tokens, MAX_OUTPUT_TOKENS);
  assert.equal(MAX_OUTPUT_TOKENS, 256);
  assert.equal(request.stream, false);
  assert.equal(request.text.format.type, 'json_schema');
  for (const omitted of ['top_p', 'tools', 'tool_choice', 'user', 'previous_response_id', 'conversation']) {
    assert.equal(Object.hasOwn(request, omitted), false, omitted);
  }
});

test('strategies share a strategy-blind prompt contract except transformed input', () => {
  for (const taskId of TASK_IDS) {
    const items = sameTask(taskId);
    assert.deepEqual(items.map((item) => item.run.strategy).sort(), [...STRATEGIES].sort());
    for (const field of ['instructions', 'model', 'temperature', 'max_output_tokens']) {
      assert.equal(new Set(items.map((item) => canonicalJson(item.request[field]))).size, 1, `${taskId}/${field}`);
    }
    assert.equal(new Set(items.map((item) => canonicalJson(item.request.text.format))).size, 1);
  }
});

test('requests exclude strategy labels and hidden benchmark metadata', () => {
  for (const item of prepared) {
    const serialized = canonicalJson(item.request);
    assert.equal(serialized.includes(item.run.strategy), false, item.run.run_id);
    for (const forbidden of ['ground_truth', 'task_requirements', 'oracle_disclosure_plan',
      'exposure_weight', 'privacy explanation', 'anonymized data']) {
      assert.equal(serialized.includes(forbidden), false, `${item.run.run_id}/${forbidden}`);
    }
  }
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'llm-experiment.js'), 'utf8');
  const rendererBody = source.slice(source.indexOf('function renderLlmCase'), source.indexOf('function schemaName'));
  for (const forbidden of ['ground_truth', 'oracle', 'strategy']) assert.equal(rendererBody.includes(forbidden), false);
});

test('schemas are closed, answer-free, and task-identical across strategies', () => {
  for (const taskId of TASK_IDS) {
    const items = sameTask(taskId);
    assert.equal(new Set(items.map((item) => sha256(item.request.text.format.schema))).size, 1);
    const schemaText = canonicalJson(items[0].request.text.format.schema);
    assert.equal(schemaText.includes('ground_truth'), false);
    assert.equal(schemaText.includes('example'), false);
    assert.equal(items[0].request.text.format.schema.additionalProperties, false);
  }
});

test('canonical manifest identifies offline validation and frozen provenance', () => {
  const canonical = buildManifest();
  assert.equal(canonical.experiment_id, 'md-bench-v0.2-deepseek-flash-contract-v0.1-offline-validation');
  assert.equal(canonical.execution_type, 'offline_mock');
  assert.equal(canonical.model_invoked, false);
  assert.equal(canonical.research_result, false);
  assert.equal(canonical.benchmark.commit, '932f16e2ccf4dab64995f11a70a054ae19b52b04');
  assert.match(canonical.contract.document_sha256, /^[0-9a-f]{64}$/);
  assert.match(canonical.schemas.document_sha256, /^[0-9a-f]{64}$/);
  const unhashed = JSON.parse(JSON.stringify(canonical));
  delete unhashed.manifest_sha256;
  assert.equal(canonical.manifest_sha256, sha256(unhashed));
});

test('140 runs use deterministic contiguous balanced Williams blocks', () => {
  const again = buildManifest({benchmarkCommit: 'test-commit'});
  assert.equal(manifest.runs.length, 140);
  assert.equal(manifest.manifest_sha256, again.manifest_sha256);
  assert.equal(new Set(manifest.runs.map((run) => `${run.task_id}/${run.strategy}/${run.repetition_index}`)).size, 140);
  const rowCounts = [0, 0, 0, 0];
  const positions = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, [0, 0, 0, 0]]));
  for (let index = 0; index < manifest.runs.length; index += 4) {
    const block = manifest.runs.slice(index, index + 4);
    assert.equal(new Set(block.map((run) => run.block_id)).size, 1);
    assert.deepEqual(block.map((run) => run.strategy).sort(), [...STRATEGIES].sort());
    rowCounts[block[0].latin_row_index] += 1;
    block.forEach((run) => { positions[run.strategy][run.strategy_position - 1] += 1; });
  }
  assert.equal(LATIN_ROWS.length, 4);
  assert.ok(Math.max(...rowCounts) - Math.min(...rowCounts) <= 1);
  for (const counts of Object.values(positions)) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.equal(canonicalJson(deterministicOrder()), canonicalJson(deterministicOrder()));
});

test('transport contract freezes timeout, retry ownership, and backoff', () => {
  assert.deepEqual(TRANSPORT_CONTRACT, {concurrency: 1, sdk_auto_retries: 0, connect_timeout_ms: 5000,
    attempt_timeout_ms: 180000, whole_run_wall_timeout_ms: 480000, max_retries: 1,
    retry_429_without_header_ms: 3000, retry_500_503_ms: 1000, retry_connection_failure_ms: 1000,
    retry_attempt_timeout_ms: 1000, retry_after_max_ms: 120000, jitter: false});
  assert.equal(manifest.execution_contract.retry_owner, 'harness-only');
  assert.equal(manifest.execution_contract.max_attempts_per_run, 2);
  assert.equal(manifest.execution_contract.attempt_count_semantics, 'attempts.length; pre-request validation does not count');
  assert.match(manifest.execution_contract.timeout_semantics, /inside, not additional to/);
  assert.ok(TRANSPORT_CONTRACT.connect_timeout_ms < TRANSPORT_CONTRACT.attempt_timeout_ms);
});

test('mock covers 140 runs and every terminal status class', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  assert.equal(report.results.length, 140);
  assert.equal(report.summary.accounted_runs, 140);
  for (const status of ['COMPLETED_CORRECT', 'COMPLETED_INCORRECT', 'INVALID_OUTPUT', 'INCOMPLETE_OUTPUT',
    'PROVIDER_FAILED', 'REQUEST_INVALID', 'AUTH_FAILED', 'BALANCE_FAILED']) {
    assert.ok(report.summary.status_counts[status] > 0, status);
  }
  assert.equal(report.summary.utility_denominator, 140);
});

test('identical retry preserves request bytes and records dispatches', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  const retried = report.results.filter((result) => result.retry_count === 1);
  assert.equal(retried.length, 6);
  for (const result of retried) {
    assert.equal(result.attempt_count, 2);
    assert.equal(result.attempts[0].request_sha256, result.attempts[1].request_sha256);
    assert.equal(result.attempts[0].request_sha256, result.request_sha256);
  }
});

test('model-output and permanent request failures are never retried', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  for (const result of report.results.filter((item) => ['INVALID_OUTPUT', 'INCOMPLETE_OUTPUT',
    'REQUEST_INVALID', 'AUTH_FAILED', 'BALANCE_FAILED'].includes(item.status))) {
    assert.equal(result.attempt_count, 1, `${result.run_id}/${result.status}`);
  }
  const scriptedWrong = report.results.find((item) => item.run_id === 'run-001');
  assert.equal(scriptedWrong.status, 'COMPLETED_INCORRECT');
  assert.equal(scriptedWrong.attempt_count, 1);
});

test('Retry-After, defaults, cap, and wall-budget gate are deterministic', () => {
  assert.deepEqual(parseRetryAfter('2', 0), {kind: 'valid', wait_ms: 2000});
  assert.equal(retryDecision({http_status: 429, retry_after: '2'}, 10).wait_ms, 2000);
  assert.equal(retryDecision({http_status: 429}, 10).wait_ms, 3000);
  assert.equal(retryDecision({http_status: 500}, 10).wait_ms, 1000);
  assert.equal(retryDecision({http_status: 503}, 10).wait_ms, 1000);
  assert.equal(retryDecision({transport_failure: 'connection_failure'}, 10).wait_ms, 1000);
  assert.equal(retryDecision({transport_failure: 'attempt_timeout'}, 10).wait_ms, 1000);
  assert.equal(retryDecision({http_status: 429, retry_after: '121'}, 10).reason, 'RETRY_AFTER_EXCEEDS_CAP');
  assert.equal(retryDecision({http_status: 429, retry_after: '120'}, 180000).reason,
    'INSUFFICIENT_RUN_WALL_BUDGET_FOR_RETRY');
});

test('mock covers retry branches without real sleep or wall overflow', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  const decisions = report.results.flatMap((result) => result.attempts.map((attempt) => attempt.retry_decision).filter(Boolean));
  for (const source of ['retry-after', 'default-429', 'default-500', 'default-503',
    'default-connection-failure', 'default-attempt-timeout']) {
    assert.ok(decisions.some((decision) => decision.wait_source === source), source);
  }
  assert.ok(report.results.some((result) => result.failure_reason === 'RETRY_AFTER_EXCEEDS_CAP'));
  assert.equal(parseRetryAfter('0', 0).kind, 'invalid');
  assert.ok(report.results.some((result) => result.failure_reason === 'INSUFFICIENT_RUN_WALL_BUDGET_FOR_RETRY'));
  assert.ok(report.results.every((result) => result.wall_time_ms <= TRANSPORT_CONTRACT.whole_run_wall_timeout_ms));
});

test('attempt count equals actual provider dispatches and keeps 140 logical runs', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  assert.equal(report.summary.http_attempt_count, report.provider.calls.length);
  assert.equal(report.summary.http_attempt_count, report.results.reduce((sum, result) => sum + result.attempts.length, 0));
  assert.equal(report.results.length, 140);
});

test('failed Agent exposure and wrong Tool exposure remain accounted', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  for (const result of report.results) assert.ok(result.exposure.ledger.some((entry) => entry.boundary === 'AGENT'));
  const wrongTool = report.results.find((result) => result.task_id === 'MD-TOOL-07' &&
    result.strategy === 'STABLE_TOKENIZATION' && result.oracle_result?.tool_status?.tool_invoked &&
    !result.oracle_result.tool_status.tool_call_correct);
  assert.ok(wrongTool);
  assert.equal(wrongTool.exposure.tool.exposure_score, 1);
  assert.equal(wrongTool.exposure.tool.category_counts.RAW_VALUE, 1);
});

test('summary reports five-run cell frequencies, macro means, and instability', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  assert.equal(report.summary.per_task_success_frequency.length, 28);
  assert.ok(report.summary.per_task_success_frequency.every((cell) => cell.repetitions === 5));
  assert.equal(Object.keys(report.summary.strategy_macro_mean_success_frequency).length, 4);
  assert.equal(report.summary.instability_count, report.summary.unstable_cells.length);
  assert.ok(report.summary.unstable_cells.every((cell) => cell.successes > 0 && cell.successes < 5));
  assert.match(report.summary.statistical_note, /not 35 independent tasks/);
});

test('artifacts are reproducible and secret scan is empty', async () => {
  const first = await runMockExperiment({benchmarkCommit: 'test-commit'});
  const second = await runMockExperiment({benchmarkCommit: 'test-commit'});
  assert.equal(first.manifest.manifest_sha256, second.manifest.manifest_sha256);
  assert.deepEqual(first.results.map((result) => result.artifact_sha256), second.results.map((result) => result.artifact_sha256));
  assert.equal(first.summary.summary_sha256, second.summary.summary_sha256);
  assert.deepEqual(first.summary.secret_scan_matches, []);
  assert.deepEqual(scanSecrets({manifest: first.manifest, results: first.results}), []);
});

test('provider failures remain in the utility denominator', async () => {
  const report = await runMockExperiment({benchmarkCommit: 'test-commit'});
  assert.equal(Object.values(report.summary.status_counts).reduce((sum, value) => sum + value, 0), 140);
  assert.ok(report.summary.provider_failure_runs > 0);
  assert.equal(report.summary.utility_denominator, report.summary.total_runs);
});

test('real provider adapter is disabled and SDK retries cannot be enabled', async () => {
  const adapter = new DeepSeekResponsesAdapter();
  assert.equal(adapter.sdk_auto_retries, 0);
  assert.throws(() => new DeepSeekResponsesAdapter({sdkAutoRetries: 1}), /SDK_AUTO_RETRIES_MUST_BE_ZERO/);
  await assert.rejects(() => adapter.send({}), /REAL_PROVIDER_DISABLED/);
});
