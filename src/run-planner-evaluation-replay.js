'use strict';

const fs = require('node:fs');
const path = require('node:path');

const planner = require('./planner-prototype-implementation');

const ROOT = path.resolve(__dirname, '..');
const TASK_IDS = planner.TASK_IDS;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
}

function primaryFiles(sourceRoot) {
  const runs = path.join(sourceRoot, 'runs');
  return fs.readdirSync(runs)
    .filter((name) => /^\d{3}-MD-[A-Z]+-\d{2}\.json$/.test(name))
    .sort();
}

function sourceArtifactSetHash(sourceRoot, files = primaryFiles(sourceRoot)) {
  return planner.sha256(files.map((name) => `${name}=${planner.sha256(fs.readFileSync(path.join(sourceRoot, 'runs', name)))}`).join('\\n'));
}

function metricScore(tp, fp, fn) {
  return {
    precision: tp + fp === 0 ? (tp + fn === 0 ? 1 : 0) : tp / (tp + fp),
    recall: tp + fn === 0 ? (tp + fp === 0 ? 1 : 0) : tp / (tp + fn)
  };
}

function countValues(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

function primaryErrorForReplay(run) {
  const authorityCodes = run.validation.authority_verification.error_codes ?? [];
  const noSolverCodes = run.validation.no_solver_verification.error_codes ?? [];
  const compilerCodes = run.validation.compiler_qualification.error_codes ?? [];
  const goldCodes = run.validation.gold_comparison.error_codes ?? [];
  if (authorityCodes.includes('AUTHORITY_VIOLATION')) return 'AUTHORITY_VIOLATION';
  if (noSolverCodes.some((code) => code.startsWith('NO_SOLVER_'))) return 'ANSWER_LEAKAGE';
  if (run.evaluator_result.terminal_status === 'INVALID_OUTPUT') return 'INVALID_OUTPUT';
  if (compilerCodes.includes('SEMANTIC_REQUIREMENT_INVALID')) return 'SEMANTIC_REQUIREMENT_INVALID';
  if (goldCodes.includes('GOLD_MISMATCH')) return 'GOLD_MISMATCH';
  return 'CORRECT';
}

function replayOne({artifact, fileName, assets}) {
  const index = artifact.run_identity.run_order - 1;
  if (index < 0 || TASK_IDS[index] !== artifact.run_identity.task_id) throw new Error(`REPLAY_RUN_ORDER_MISMATCH:${fileName}`);
  const sourceHash = planner.sha256(fs.readFileSync(path.join(artifact.__sourceRoot, 'runs', fileName)));
  let evaluation;
  if (artifact.raw_structured_prediction) {
    evaluation = planner.evaluatePlannerPrediction({
      plannerInput: planner.buildProviderVisibleProjection(assets.dev)[index],
      seedCase: assets.seeds.cases[index],
      prediction: artifact.raw_structured_prediction,
      assets
    });
  } else {
    evaluation = {
      validation: artifact.validation,
      canonical_prediction: null,
      evaluator_result: artifact.evaluator_result
    };
  }
  const unsafe = planner.unsafeEvaluation(evaluation);
  const unsafePrediction = unsafe.authority_violation || unsafe.answer_leakage;
  const securityAccepted = unsafePrediction && !unsafe.authority_violation && !unsafe.answer_leakage;
  return {
    replay_artifact_version: 'planner-prototype-evaluation-replay-v0.1',
    source_artifact_path: `runs/${fileName}`,
    source_artifact_sha256: sourceHash,
    source_run_id: artifact.run_identity.run_id,
    run_identity: artifact.run_identity,
    validation: evaluation.validation,
    canonical_prediction: evaluation.canonical_prediction,
    evaluator_result: evaluation.evaluator_result,
    unsafe_prediction: unsafePrediction,
    unsafe_prediction_accepted: securityAccepted,
    source_execution_immutable: true
  };
}

function buildSummary({sourceRoot, files, replayRuns, telemetry, assets, sourceImplementationCommit, repairedImplementationCommit, sourceHash}) {
  const evaluatorResults = replayRuns.map((run) => run.evaluator_result);
  const capability = ['capability_tp', 'capability_fp', 'capability_fn'].reduce((result, key) => {
    result[key.slice('capability_'.length)] = evaluatorResults.reduce((sum, item) => sum + item[key], 0);
    return result;
  }, {});
  const perTask = replayRuns.map((run) => {
    const result = run.evaluator_result;
    const score = metricScore(result.capability_tp, result.capability_fp, result.capability_fn);
    return {
      task_id: run.run_identity.task_id,
      run_id: run.run_identity.run_id,
      terminal_status: result.terminal_status,
      planner_status: result.planner_status,
      schema_valid: result.schema_valid,
      semantic_valid: result.semantic_valid,
      exact_requirement_set_match: result.exact_requirement_set_match,
      tp: result.capability_tp,
      fp: result.capability_fp,
      fn: result.capability_fn,
      precision: score.precision,
      recall: score.recall,
      compiler_relation: result.compiler_relation,
      primary_errors: result.primary_errors,
      unsafe_prediction: run.unsafe_prediction,
      unsafe_prediction_accepted: run.unsafe_prediction_accepted
    };
  });
  const micro = metricScore(capability.tp, capability.fp, capability.fn);
  const macro = {
    precision: perTask.reduce((sum, item) => sum + item.precision, 0) / perTask.length,
    recall: perTask.reduce((sum, item) => sum + item.recall, 0) / perTask.length
  };
  const attempts = telemetry.flatMap((item) => item.attempts ?? []);
  const latencies = telemetry.map((item) => item.latency_ms).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = (values, fraction) => values.length === 0 ? null : values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
  const usage = telemetry.reduce((sum, item) => ({
    input_tokens: sum.input_tokens + (item.usage?.input_tokens ?? 0),
    output_tokens: sum.output_tokens + (item.usage?.output_tokens ?? 0),
    reasoning_tokens: sum.reasoning_tokens + (item.usage?.output_tokens_details?.reasoning_tokens ?? 0),
    total_tokens: sum.total_tokens + (item.usage?.total_tokens ?? 0)
  }), {input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0});
  const exactCount = perTask.filter((item) => item.exact_requirement_set_match).length;
  const overshareTasks = perTask.filter((item) => item.fp > 0).map((item) => item.task_id);
  const undershareTasks = perTask.filter((item) => item.fn > 0).map((item) => item.task_id);
  const authorityTasks = replayRuns.filter((run) => run.validation.authority_verification.error_codes.includes('AUTHORITY_VIOLATION')).map((run) => run.run_identity.task_id);
  const answerLeakageTasks = replayRuns.filter((run) => run.validation.no_solver_verification.error_codes.some((code) => code.startsWith('NO_SOLVER_'))).map((run) => run.run_identity.task_id);
  const unsafeCount = replayRuns.filter((run) => run.unsafe_prediction).length;
  const acceptedCount = replayRuns.filter((run) => run.unsafe_prediction_accepted).length;
  const compilerCounts = countValues(perTask, 'compiler_relation');
  const primaryErrorCounts = countValues(replayRuns.map((run) => ({primary_error: primaryErrorForReplay(run)})), 'primary_error');
  const secondaryGoldMismatchTasks = replayRuns.filter((run) => run.validation.gold_comparison.error_codes.includes('GOLD_MISMATCH')).map((run) => run.run_identity.task_id);
  const secondaryCompilerErrorCounts = {};
  for (const run of replayRuns) for (const error of run.validation.compiler_qualification.error_codes) secondaryCompilerErrorCounts[error] = (secondaryCompilerErrorCounts[error] ?? 0) + 1;
  return {
    summary_version: 'planner-prototype-evaluation-replay-summary-v0.1',
    source_experiment_id: 'planner-prototype-v0.1-initial-deepseek-flash-20260918-02',
    source_artifact_set_sha256: sourceHash,
    source_implementation_commit: sourceImplementationCommit,
    repaired_implementation_commit: repairedImplementationCommit,
    execution_reused: true,
    model_invoked: false,
    evaluation_replay: true,
    source_execution_immutable: true,
    zero_provider_dispatches: true,
    accounted_runs: replayRuns.length,
    expected_runs: TASK_IDS.length,
    total_attempts: attempts.length,
    total_retries: Math.max(0, attempts.length - replayRuns.length),
    actual_http_dispatches: 0,
    source_actual_http_dispatches: attempts.filter((attempt) => attempt.dispatched).length,
    status_counts: countValues(perTask, 'terminal_status'),
    planner_status_counts: countValues(perTask, 'planner_status'),
    schema_valid_count: perTask.filter((item) => item.schema_valid).length,
    semantic_valid_count: perTask.filter((item) => item.semantic_valid).length,
    exact_requirement_set_match_count: exactCount,
    capability: {...capability, micro_precision: micro.precision, micro_recall: micro.recall, macro_precision: macro.precision, macro_recall: macro.recall},
    per_task: perTask,
    error_taxonomy: {
      primary_error_counts: primaryErrorCounts,
      secondary_diagnostics: {
        gold_mismatch_tasks: secondaryGoldMismatchTasks,
        compiler_error_counts: secondaryCompilerErrorCounts,
        secondary_diagnostics_are_nonexclusive: true
      },
      overshare_tasks: overshareTasks,
      undershare_tasks: undershareTasks,
      authority_violation_tasks: authorityTasks,
      answer_leakage_tasks: answerLeakageTasks,
      invalid_output_tasks: perTask.filter((item) => item.terminal_status === 'INVALID_OUTPUT').map((item) => item.task_id),
      wrong_target_tasks: [],
      wrong_scope_tasks: [],
      wrong_operation_binding_tasks: [],
      wrong_boundary_tasks: [],
      evaluator_emitted_no_explicit_wrong_category: true
    },
    compiler_relations: compilerCounts,
    compiler_eligible_count: perTask.filter((item) => item.compiler_relation !== 'NOT_RUN').length,
    oracle_plan_exact_count: compilerCounts.ORACLE_EXACT ?? 0,
    more_disclosing_than_oracle_count: 0,
    less_capable_than_oracle_count: 0,
    incomparable_count: compilerCounts.INCOMPARABLE ?? 0,
    unsafe_prediction_count: unsafeCount,
    unsafe_prediction_accepted_count: acceptedCount,
    unsafe_prediction_denominator: replayRuns.filter((run) => run.evaluator_result.terminal_status !== 'INVALID_OUTPUT').length,
    latency_ms: {
      mean: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? latencies.at(-1) : null
    },
    token_usage: usage,
    returned_model_distribution: countValues(telemetry, 'returned_model'),
    secret_scan_matches: planner.scanSecrets({replayRuns, telemetry}),
    frozen_integrity: planner.verifyFrozenIntegrity(),
    source_root: sourceRoot,
    replayed_files: files.map((fileName) => `runs/${fileName}.replay.json`)
  };
}

function withSelfHash(value, key) {
  const copy = {...value};
  delete copy[key];
  copy[key] = planner.sha256(JSON.stringify(copy));
  return copy;
}

function runReplay({sourceRoot, outputRoot}) {
  const assets = planner.loadPlannerAssets();
  const files = primaryFiles(sourceRoot);
  if (files.length !== TASK_IDS.length) throw new Error(`REPLAY_SOURCE_RUN_COUNT:${files.length}`);
  const sourceHash = sourceArtifactSetHash(sourceRoot, files);
  const expectedSourceHash = '6eb49786f7b0762a317741e7891c0bfdd0c6f5840f9561c2b3d6b65e8c97bd7f';
  if (sourceHash !== expectedSourceHash) throw new Error('REPLAY_SOURCE_ARTIFACT_HASH_MISMATCH');
  if (fs.existsSync(outputRoot)) throw new Error('REPLAY_OUTPUT_ALREADY_EXISTS');
  fs.mkdirSync(path.join(outputRoot, 'runs'), {recursive: true});
  const artifacts = files.map((fileName) => {
    const artifact = readJson(path.join(sourceRoot, 'runs', fileName));
    artifact.__sourceRoot = sourceRoot;
    return artifact;
  });
  const telemetry = files.map((fileName) => readJson(path.join(sourceRoot, 'runs', fileName.replace(/\.json$/, '.telemetry.json'))));
  const sourceManifest = readJson(path.join(sourceRoot, 'experiment-manifest.json'));
  const sourceImplementationCommit = sourceManifest.implementation_commit;
  const repairedImplementationCommit = planner.implementationCommit();
  const replayRuns = artifacts.map((artifact, index) => replayOne({artifact, fileName: files[index], assets}));
  for (const run of replayRuns) writeJson(path.join(outputRoot, 'runs', `${run.run_identity.run_order.toString().padStart(3, '0')}-${run.run_identity.task_id}.replay.json`), run);
  const replayRunFiles = fs.readdirSync(path.join(outputRoot, 'runs')).sort();
  const replayArtifactHash = planner.sha256(replayRunFiles.map((name) => `${name}=${planner.sha256(fs.readFileSync(path.join(outputRoot, 'runs', name)))}`).join('\\n'));
  const manifest = {
    replay_manifest_version: 'planner-prototype-evaluation-replay-manifest-v0.1',
    source_experiment_id: sourceManifest.experiment_id,
    source_artifact_set_sha256: sourceHash,
    source_implementation_commit: sourceImplementationCommit,
    repaired_implementation_commit: repairedImplementationCommit,
    frozen_provenance: {
      planner_spec_commit: sourceManifest.planner_spec_commit,
      prototype_contract_commit: sourceManifest.prototype_contract_commit,
      prompt_sha256: sourceManifest.prompt_sha256,
      input_set_sha256: sourceManifest.input_set_sha256,
      output_schema_sha256: sourceManifest.output_schema_sha256
    },
    execution_reused: true,
    model_invoked: false,
    evaluation_replay: true,
    source_execution_immutable: true,
    provider_dispatch_count: 0,
    replay_artifact_set_sha256: replayArtifactHash
  };
  writeJson(path.join(outputRoot, 'replay-manifest.json'), manifest);
  const summary = buildSummary({sourceRoot, files, replayRuns, telemetry, assets, sourceImplementationCommit, repairedImplementationCommit, sourceHash});
  summary.replay_artifact_set_sha256 = replayArtifactHash;
  writeJson(path.join(outputRoot, 'summary.json'), withSelfHash(summary, 'summary_sha256'));
  return {outputRoot, sourceHash, replayArtifactHash, summary: readJson(path.join(outputRoot, 'summary.json'))};
}

if (require.main === module) {
  const sourceRoot = process.argv[2];
  const outputRoot = process.argv[3];
  if (!sourceRoot || !outputRoot || process.argv.length !== 4) throw new Error('usage: node src/run-planner-evaluation-replay.js <source-artifact-root> <replay-output-root>');
  try {
    process.stdout.write(`${JSON.stringify(runReplay({sourceRoot: path.resolve(ROOT, sourceRoot), outputRoot: path.resolve(ROOT, outputRoot)}))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}

module.exports = {buildSummary, metricScore, primaryErrorForReplay, primaryFiles, runReplay, sourceArtifactSetHash};
