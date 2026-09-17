'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {loadFixture} = require('./md-bench-v0.2');
const {
  DEEPSEEK_RESPONSES_URL,
  DeepSeekResponsesAdapter,
  RealClock,
  STATUSES,
  buildManifest,
  buildPreparedRuns,
  canonicalJson,
  executePreparedRun,
  scanSecrets,
  sha256,
  successStatistics,
  withSelfHash
} = require('./llm-experiment');

const ROOT = path.resolve(__dirname, '..');
const FROZEN_MANIFEST_PATH = path.join(ROOT, 'artifacts', 'llm',
  'md-bench-v0.2-deepseek-flash-contract-v0.1-offline-validation', 'experiment-manifest.json');
const FORMAL_ID_PATTERN = /^md-bench-v0\.2-deepseek-flash-formal-[a-z0-9][a-z0-9._-]*$/;
const PROVIDER_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runIdentities(manifest) {
  return manifest.runs.map(({run_id, run_order, task_id, strategy, repetition_index,
    block_id, latin_row_index, strategy_position}) => ({run_id, run_order, task_id, strategy,
    repetition_index, block_id, latin_row_index, strategy_position}));
}

function loadFrozenManifest() {
  const frozen = readJson(FROZEN_MANIFEST_PATH);
  const rebuilt = buildManifest();
  if (canonicalJson(frozen) !== canonicalJson(rebuilt)) throw new Error('FROZEN_MANIFEST_REBUILD_MISMATCH');
  if (frozen.runs.length !== 140) throw new Error('FROZEN_RUN_COUNT_MISMATCH');
  const identities = runIdentities(frozen);
  if (new Set(identities.map((run) => run.run_id)).size !== 140) throw new Error('DUPLICATE_FROZEN_RUN_ID');
  if (new Set(identities.map((run) => `${run.task_id}/${run.strategy}/${run.repetition_index}`)).size !== 140) {
    throw new Error('DUPLICATE_FROZEN_LOGICAL_RUN');
  }
  identities.forEach((run, index) => {
    if (run.run_order !== index + 1 || run.run_id !== `run-${String(index + 1).padStart(3, '0')}`) {
      throw new Error('FROZEN_RUN_ORDER_MISMATCH');
    }
  });
  return frozen;
}

function validateProviderSnapshot(snapshot, nowMs = Date.now()) {
  const unhashed = JSON.parse(JSON.stringify(snapshot));
  delete unhashed.snapshot_sha256;
  if (snapshot.snapshot_sha256 !== sha256(unhashed)) throw new Error('PROVIDER_SNAPSHOT_HASH_MISMATCH');
  if (snapshot.provider !== 'DeepSeek' || snapshot.requested_model !== 'deepseek-flash' ||
      snapshot.responses_endpoint !== DEEPSEEK_RESPONSES_URL) {
    throw new Error('PROVIDER_SNAPSHOT_CONTRACT_MISMATCH');
  }
  if (snapshot.alias_routing_change_detected !== false) throw new Error('PROVIDER_ALIAS_CHANGE_DETECTED');
  const checkedAt = Date.parse(snapshot.provider_docs_checked_at);
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs + 5 * 60 * 1000 || nowMs - checkedAt > PROVIDER_SNAPSHOT_MAX_AGE_MS) {
    throw new Error('PROVIDER_SNAPSHOT_NOT_FRESH');
  }
  return snapshot;
}

function collectImplementationProvenance() {
  const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
  const trackedStatus = childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
    {cwd: ROOT, encoding: 'utf8'}).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('IMPLEMENTATION_COMMIT_INVALID');
  if (trackedStatus) throw new Error('TRACKED_SOURCE_NOT_CLEAN');
  try {
    childProcess.execFileSync('git', ['ls-files', '--error-unmatch', '--', 'src/run-formal-batch.js'],
      {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  } catch {
    throw new Error('FORMAL_LAUNCHER_NOT_COMMITTED');
  }
  return {commit, tracked_source_clean: true, launcher_path: 'src/run-formal-batch.js',
    launcher_sha256: sha256(fs.readFileSync(__filename))};
}

function buildFormalManifest({experimentId, frozenManifest, providerSnapshot, providerSnapshotPath,
  implementation, startedAt = new Date().toISOString()}) {
  if (!FORMAL_ID_PATTERN.test(experimentId)) throw new Error('FORMAL_EXPERIMENT_ID_INVALID');
  if (!/^[0-9a-f]{40}$/.test(implementation.commit) || implementation.tracked_source_clean !== true ||
      implementation.launcher_path !== 'src/run-formal-batch.js' ||
      !/^[0-9a-f]{64}$/.test(implementation.launcher_sha256)) {
    throw new Error('FORMAL_IMPLEMENTATION_PROVENANCE_INVALID');
  }
  const identities = runIdentities(frozenManifest);
  const formal = JSON.parse(JSON.stringify(frozenManifest));
  formal.experiment_id = experimentId;
  formal.execution_mode = 'formal_live_batch';
  formal.formal_experiment_started = true;
  formal.execution_type = 'formal_live';
  formal.model_invoked = true;
  formal.research_result = true;
  formal.provider = {...formal.provider,
    documented_serving_model: providerSnapshot.documented_serving_model,
    provider_docs_checked_at: providerSnapshot.provider_docs_checked_at};
  formal.formal_provenance = {
    started_at: startedAt,
    implementation_commit: implementation.commit,
    tracked_source_clean: implementation.tracked_source_clean,
    launcher_path: implementation.launcher_path,
    launcher_sha256: implementation.launcher_sha256,
    frozen_manifest_path: path.relative(ROOT, FROZEN_MANIFEST_PATH).replace(/\\/g, '/'),
    frozen_manifest_sha256: frozenManifest.manifest_sha256,
    frozen_run_identities_sha256: sha256(identities),
    provider_snapshot_path: providerSnapshotPath,
    provider_snapshot_sha256: providerSnapshot.snapshot_sha256
  };
  delete formal.manifest_sha256;
  return withSelfHash(formal, 'manifest_sha256');
}

async function executeSerial(items, delegate) {
  const results = [];
  for (const item of items) results.push(await delegate(item));
  return results;
}

function formalExecutionStatus(status) {
  if (status === 'COMPLETED_CORRECT' || status === 'COMPLETED_INCORRECT') return 'COMPLETED_STRUCTURED';
  return status;
}

function formalCorrectnessStatus(status) {
  if (status === 'COMPLETED_CORRECT') return 'CORRECT';
  if (status === 'COMPLETED_INCORRECT') return 'INCORRECT';
  return 'NOT_SCORED';
}

function summarizeFormalRuns(results, manifest, actualDispatches) {
  if (results.length !== manifest.execution_contract.total_runs || results.length !== 140) {
    throw new Error('FORMAL_SUMMARY_DENOMINATOR_MISMATCH');
  }
  const terminalStatusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  const executionStatusCounts = {};
  const correctnessStatusCounts = {CORRECT: 0, INCORRECT: 0, NOT_SCORED: 0};
  results.forEach((result, index) => {
    if (canonicalJson(runIdentities({runs: [result]})[0]) !== canonicalJson(runIdentities(manifest)[index])) {
      throw new Error('FORMAL_RESULT_ORDER_MISMATCH');
    }
    terminalStatusCounts[result.status] += 1;
    const executionStatus = formalExecutionStatus(result.status);
    executionStatusCounts[executionStatus] = (executionStatusCounts[executionStatus] ?? 0) + 1;
    correctnessStatusCounts[formalCorrectnessStatus(result.status)] += 1;
  });
  const recordedAttempts = results.reduce((sum, result) => sum + result.attempt_count, 0);
  if (actualDispatches !== recordedAttempts) throw new Error('FORMAL_DISPATCH_ACCOUNTING_MISMATCH');
  const summary = {
    experiment_id: manifest.experiment_id,
    execution_mode: manifest.execution_mode,
    execution_type: manifest.execution_type,
    formal_experiment_started: true,
    model_invoked: true,
    research_result: true,
    total_runs: 140,
    denominator: 140,
    utility_denominator: 140,
    accounted_runs: 140,
    status_counts: terminalStatusCounts,
    terminal_status_counts: terminalStatusCounts,
    execution_status_counts: executionStatusCounts,
    correctness_status_counts: correctnessStatusCounts,
    completed_correct: terminalStatusCounts.COMPLETED_CORRECT,
    provider_failure_runs: results.filter((result) =>
      ['PROVIDER_FAILED', 'REQUEST_INVALID', 'AUTH_FAILED', 'BALANCE_FAILED'].includes(result.status)).length,
    retry_attempts: results.reduce((sum, result) => sum + result.retry_count, 0),
    recorded_http_attempts: recordedAttempts,
    actual_http_dispatches: actualDispatches,
    repetitions_per_cell: manifest.execution_contract.repetitions,
    independent_task_count: manifest.execution_contract.independent_task_count,
    executions_per_strategy: manifest.execution_contract.independent_task_count * manifest.execution_contract.repetitions,
    ...successStatistics(results),
    statistical_note: 'The 35 executions per strategy are repeated observations over 7 tasks, not 35 independent tasks; no ordinary Bernoulli confidence interval is reported.',
    provenance: manifest.formal_provenance,
    manifest_sha256: manifest.manifest_sha256,
    run_artifact_set_sha256: sha256(results.map((result) => ({
      run_id: result.run_id,
      artifact_sha256: result.artifact_sha256
    }))),
    completed_at: new Date().toISOString(),
    secret_scan_matches: scanSecrets({manifest, results})
  };
  return withSelfHash(summary, 'summary_sha256');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
}

async function runFormalBatch({manifest, fixture, provider, outputRoot}) {
  if (fs.existsSync(outputRoot)) throw new Error('FORMAL_OUTPUT_ALREADY_EXISTS');
  const prepared = buildPreparedRuns(fixture, manifest);
  if (canonicalJson(prepared.map((item) => item.run)) !== canonicalJson(manifest.runs)) {
    throw new Error('PREPARED_RUN_ORDER_MISMATCH');
  }
  fs.mkdirSync(path.join(outputRoot, 'runs'), {recursive: true});
  writeJson(path.join(outputRoot, 'experiment-manifest.json'), manifest);
  const results = await executeSerial(prepared, async (item) => {
    const result = await executePreparedRun(item, provider, fixture, manifest, {clock: new RealClock()});
    writeJson(path.join(outputRoot, 'runs', `${result.run_id}.json`), result);
    return result;
  });
  const actualDispatches = Number.isInteger(provider.dispatch_count) ? provider.dispatch_count : provider.calls?.length;
  if (!Number.isInteger(actualDispatches)) throw new Error('PROVIDER_DISPATCH_COUNT_UNAVAILABLE');
  const summary = summarizeFormalRuns(results, manifest, actualDispatches);
  writeJson(path.join(outputRoot, 'summary.json'), summary);
  return {manifest, results, summary};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--run') {
    throw new Error('usage: node src/run-formal-batch.js --run <formal-experiment-id> <provider-snapshot.json>');
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('MISSING_DEEPSEEK_API_KEY: formal batch not started');
  const experimentId = args[1];
  const providerSnapshotFile = path.resolve(args[2]);
  const providerSnapshot = validateProviderSnapshot(readJson(providerSnapshotFile));
  const frozenManifest = loadFrozenManifest();
  const implementation = collectImplementationProvenance();
  const providerSnapshotPath = path.relative(ROOT, providerSnapshotFile).replace(/\\/g, '/');
  const manifest = buildFormalManifest({experimentId, frozenManifest, providerSnapshot,
    providerSnapshotPath, implementation});
  const outputRoot = path.join(ROOT, 'artifacts', 'llm', experimentId);
  const report = await runFormalBatch({manifest, fixture: loadFixture(),
    provider: new DeepSeekResponsesAdapter(), outputRoot});
  process.stdout.write(`${JSON.stringify({output: outputRoot, summary: report.summary})}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FORMAL_ID_PATTERN,
  FROZEN_MANIFEST_PATH,
  PROVIDER_SNAPSHOT_MAX_AGE_MS,
  buildFormalManifest,
  collectImplementationProvenance,
  executeSerial,
  formalCorrectnessStatus,
  formalExecutionStatus,
  loadFrozenManifest,
  runFormalBatch,
  runIdentities,
  summarizeFormalRuns,
  validateProviderSnapshot
};
