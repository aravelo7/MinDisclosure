'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {loadFixture} = require('../src/md-bench-v0.2');
const {projectSolverCase, solveTask} = require('../src/solver');
const {
  FakeProvider,
  buildPreparedRuns,
  canonicalJson,
  scanSecrets,
  sha256
} = require('../src/llm-experiment');
const {
  FROZEN_MANIFEST_PATH,
  buildFormalManifest,
  executeSerial,
  loadFrozenManifest,
  runFormalBatch,
  runIdentities,
  validateProviderSnapshot
} = require('../src/run-formal-batch');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'artifacts', 'llm', 'engineering-smoke-v0.1',
  'provider-snapshot.json');
const IMPLEMENTATION_COMMIT = 'a'.repeat(40);

function loadProviderSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function formalManifest() {
  const frozenManifest = loadFrozenManifest();
  const providerSnapshot = loadProviderSnapshot();
  validateProviderSnapshot(providerSnapshot, Date.parse(providerSnapshot.provider_docs_checked_at) + 1);
  return buildFormalManifest({
    experimentId: 'md-bench-v0.2-deepseek-flash-formal-offline-test',
    frozenManifest,
    providerSnapshot,
    providerSnapshotPath: 'artifacts/llm/engineering-smoke-v0.1/provider-snapshot.json',
    implementation: {commit: IMPLEMENTATION_COMMIT, tracked_source_clean: true,
      launcher_path: 'src/run-formal-batch.js', launcher_sha256: 'b'.repeat(64)},
    startedAt: '2026-09-17T13:00:00.000Z'
  });
}

function successfulAttempt(item) {
  const output = solveTask(projectSolverCase(item.task, item.transformed));
  return {
    http_status: 200,
    latency_ms: 1,
    response_headers: {'content-type': 'application/json'},
    retry_after: null,
    response_body_sha256: sha256(JSON.stringify(output)),
    response: {
      id: `resp_${item.run.run_id}`,
      created_at: 1789574400,
      status: 'completed',
      model: 'deepseek-flash',
      output: [{type: 'message', status: 'completed',
        content: [{type: 'output_text', text: JSON.stringify(output)}]}],
      usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
      error: null,
      incomplete_details: null
    },
    provider_error: null,
    transport_failure: false,
    error: null
  };
}

test('frozen manifest rebuilds to exactly 140 unique identities in frozen order', () => {
  const frozen = loadFrozenManifest();
  const persisted = JSON.parse(fs.readFileSync(FROZEN_MANIFEST_PATH, 'utf8'));
  assert.equal(frozen.runs.length, 140);
  assert.equal(new Set(frozen.runs.map((run) => run.run_id)).size, 140);
  assert.equal(new Set(frozen.runs.map((run) => `${run.task_id}/${run.strategy}/${run.repetition_index}`)).size, 140);
  assert.equal(canonicalJson(runIdentities(frozen)), canonicalJson(runIdentities(persisted)));
  assert.deepEqual(frozen.runs.map((run) => run.run_order), Array.from({length: 140}, (_, index) => index + 1));
});

test('formal manifest retains frozen identities and complete formal provenance', () => {
  const manifest = formalManifest();
  const frozen = loadFrozenManifest();
  assert.equal(canonicalJson(runIdentities(manifest)), canonicalJson(runIdentities(frozen)));
  assert.equal(manifest.execution_contract.topology, 'serial');
  assert.equal(manifest.execution_contract.concurrency, 1);
  assert.equal(manifest.execution_contract.retry_owner, 'harness-only');
  assert.equal(manifest.formal_provenance.implementation_commit, IMPLEMENTATION_COMMIT);
  assert.equal(manifest.formal_provenance.launcher_path, 'src/run-formal-batch.js');
  assert.equal(manifest.formal_provenance.launcher_sha256, 'b'.repeat(64));
  assert.equal(manifest.formal_provenance.frozen_manifest_sha256, frozen.manifest_sha256);
  assert.match(manifest.formal_provenance.frozen_run_identities_sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.formal_provenance.provider_snapshot_sha256, /^[0-9a-f]{64}$/);
});

test('serial primitive delegates once per item with maximum concurrency one', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const values = await executeSerial(Array.from({length: 140}, (_, index) => index + 1), async (value) => {
    calls.push(value);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return value;
  });
  assert.deepEqual(calls, values);
  assert.equal(calls.length, 140);
  assert.equal(new Set(calls).size, 140);
  assert.equal(maximumActive, 1);
});

test('formal batch uses canonical prepared-run execution once, persists 140 artifacts, and fixes denominator at 140', async () => {
  const manifest = formalManifest();
  const fixture = loadFixture();
  const prepared = buildPreparedRuns(fixture, manifest);
  const scripts = new Map(prepared.map((item) => [item.run.run_id, [successfulAttempt(item)]]));
  const provider = new FakeProvider(scripts);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindisclosure-formal-batch-'));
  const outputRoot = path.join(temporaryRoot, 'formal-output');
  try {
    const report = await runFormalBatch({manifest, fixture, provider, outputRoot});
    assert.equal(report.results.length, 140);
    assert.equal(provider.calls.length, 140);
    assert.deepEqual(provider.calls.map((call) => call.run_id), manifest.runs.map((run) => run.run_id));
    assert.equal(report.summary.denominator, 140);
    assert.equal(report.summary.total_runs, 140);
    assert.equal(report.summary.accounted_runs, 140);
    assert.equal(report.summary.recorded_http_attempts, 140);
    assert.equal(report.summary.actual_http_dispatches, 140);
    assert.equal(report.summary.execution_status_counts.COMPLETED_STRUCTURED, 140);
    assert.equal(Object.values(report.summary.correctness_status_counts).reduce((sum, count) => sum + count, 0), 140);
    assert.equal(fs.readdirSync(path.join(outputRoot, 'runs')).length, 140);
    assert.ok(fs.existsSync(path.join(outputRoot, 'experiment-manifest.json')));
    assert.ok(fs.existsSync(path.join(outputRoot, 'summary.json')));
    assert.deepEqual(scanSecrets(report), []);

    const callCount = provider.calls.length;
    await assert.rejects(() => runFormalBatch({manifest, fixture, provider, outputRoot}),
      /FORMAL_OUTPUT_ALREADY_EXISTS/);
    assert.equal(provider.calls.length, callCount);
  } finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test('formal launcher has one canonical delegate and no batch retry or parallel owner', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'run-formal-batch.js'), 'utf8');
  assert.equal((source.match(/executePreparedRun\(/g) ?? []).length, 1);
  for (const forbidden of ['executeWithRetry', 'retryDecision', 'Promise.all', 'max_retries',
    'setTimeout(', 'https.request', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
