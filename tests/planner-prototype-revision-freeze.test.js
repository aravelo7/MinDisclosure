'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/planner-prototype-implementation');
const replayRunner = require('../src/run-planner-evaluation-replay');

const ROOT = path.resolve(__dirname, '..');
const readBytes = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath));
const readJson = (relativePath) => JSON.parse(readBytes(relativePath).toString('utf8'));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const CLASSIFICATION_PATH =
  'artifacts/planner-development/' +
  'planner-prototype-v0.1-initial-failure-classification.json';
const DECISION_PATH =
  'artifacts/planner-development/' +
  'planner-prototype-v0.1-development-revision-decision.json';
const DIFF_PATH =
  'artifacts/planner-development/' +
  'planner-prototype-v0.1-prompt-exact-diff.json';
const REVISED_PROMPT_PATH = 'prompts/planner-prototype-v0.1-revised.txt';

const CLASSIFICATION_SHA =
  '7857308501fda5ae2bcf8dfdb7513009c99847f535a1012fb41e6a73e1bf99a8';
const REVISED_PROMPT_SHA =
  'dc4fb968785b14e34dd37d651ef6a7dacc11b4c3b4ebd3bc125579fa0ec3fa7b';
const DIFF_SHA =
  'd85ac3032e40aa8454c5eff914b3c87e23eb0f66af743b89a5fa2160a7e1ab37';
const DENYLIST_SHA =
  'f5496fd857b56ff3ba7d1c469b9270c2079f07b56f41d8b7241611149965240f';

const TASK_IDS = [
  'MD-EQ-01',
  'MD-GROUP-02',
  'MD-ORDER-03',
  'MD-LOC-04',
  'MD-CROSS-05',
  'MD-GRAPH-06',
  'MD-TOOL-07'
];

function collectLeaves(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectLeaves(item, result));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectLeaves(item, result));
  } else if (typeof value === 'string' || typeof value === 'number') {
    result.push(String(value));
  }
  return result;
}

function revisionDenylist() {
  const dev = readJson('fixtures/planner-prototype-dev-cases-v0.1.1.json');
  const seeds = readJson('fixtures/planner-seed-cases-v0.2.1.json');
  const benchmark = readJson('fixtures/md-bench-v0.2.json');
  const values = [
    ...TASK_IDS,
    ...dev.cases.map((item) => item.case_id),
    ...dev.cases.map((item) => item.planner_input.task.instruction),
    ...dev.cases.flatMap((item) =>
      item.planner_input.abstract_data_schema.fields.map((field) =>
        field.field_ref)),
    ...seeds.cases.flatMap((item) =>
      item.planner_document.task_ir.operations.map((operation) =>
        operation.operation_id)),
    ...seeds.cases.flatMap((item) =>
      item.planner_document.capability_requirements.requirements.map(
        (requirement) => requirement.requirement_id)),
    ...seeds.cases.flatMap((item) =>
      item.oracle_bridge.expected_reporting_plan.map((action) =>
        action.transformation_id)),
    ...benchmark.tasks.map((item) => JSON.stringify(item.ground_truth)),
    ...benchmark.tasks.flatMap((item) =>
      collectLeaves(item.ground_truth).filter((value) =>
        value.length >= 2 && !/^[0-9]+(?:\.[0-9]+)?$/.test(value)))
  ];
  return [...new Set(values)].sort();
}

function admissibilityCounts(prompt, rationale) {
  const dev = readJson('fixtures/planner-prototype-dev-cases-v0.1.1.json');
  const seeds = readJson('fixtures/planner-seed-cases-v0.2.1.json');
  const benchmark = readJson('fixtures/md-bench-v0.2.json');
  const text = `${prompt.toString('utf8')}\n${rationale}`
    .normalize('NFC').toLowerCase();
  const countMatches = (values) => [...new Set(values)].filter((value) =>
    text.includes(value.normalize('NFC').toLowerCase())).length;
  return {
    semantic_task_ids: countMatches(TASK_IDS),
    gold_operation_ids: countMatches(seeds.cases.flatMap((item) =>
      item.planner_document.task_ir.operations.map((operation) =>
        operation.operation_id))),
    gold_requirement_ids: countMatches(seeds.cases.flatMap((item) =>
      item.planner_document.capability_requirements.requirements.map(
        (requirement) => requirement.requirement_id))),
    oracle_actions: countMatches(seeds.cases.flatMap((item) =>
      item.oracle_bridge.expected_reporting_plan.map((action) =>
        action.transformation_id))),
    expected_answers: countMatches(benchmark.tasks.map((item) =>
      JSON.stringify(item.ground_truth))),
    seed_specific_field_names: countMatches(dev.cases.flatMap((item) =>
      item.planner_input.abstract_data_schema.fields.map((field) =>
        field.field_ref))),
    task_specific_branching:
      (text.match(/\b(eq|group|order|loc|cross|graph|tool)\s+(task|case)\b/g) ?? [])
        .length,
    complete_gold_examples:
      /"task_ir"\s*:/.test(text) && /"requirements"\s*:/.test(text) ? 1 : 0,
    few_shot_examples:
      (text.match(/\b(example\s*:|few[- ]?shot)\b/g) ?? []).length
  };
}

test('initial failure classification is frozen from repaired replay', () => {
  const bytes = readBytes(CLASSIFICATION_PATH);
  const classification = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha256(bytes), CLASSIFICATION_SHA);
  assert.equal(classification.initial_failure_classification_frozen, true);
  assert.equal(classification.authoritative_evaluation.capability.tp, 3);
  assert.equal(classification.authoritative_evaluation.capability.fp, 13);
  assert.equal(classification.authoritative_evaluation.capability.fn, 7);
  assert.equal(classification.authoritative_evaluation.exact_requirement_set_match,
    '0/7');
  assert.equal(classification.cases.length, 7);
  assert.equal(classification.cases[4].primary_class, 'OUTPUT_FORMAT_FAILURE');
  assert.deepEqual(classification.cases[4].model_semantic_failures, []);
  assert.equal(classification.cases[6].primary_class, 'SECURITY_FAILURE');
  assert.equal(classification.cases[6].security_failure, true);
  assert.equal(classification.authoritative_evaluation.security.unsafe_accepted, 0);
  assert.equal(classification.general_failure_patterns.length, 3);
  assert.ok(classification.general_failure_patterns.every((pattern) =>
    pattern.cross_task_evidence.length >= 2));
});

test('revised prompt is an addition-only general revision', () => {
  const initial = readBytes('prompts/planner-prototype-v0.1.txt');
  const revised = readBytes(REVISED_PROMPT_PATH);
  const added = revised.toString('utf8')
    .replace(initial.toString('utf8').slice(0,
      initial.toString('utf8').indexOf('1. Infer Task IR')), '')
    .replace(initial.toString('utf8').slice(
      initial.toString('utf8').indexOf('1. Infer Task IR')), '');
  assert.equal(sha256(initial), planner.INITIAL_PROMPT_SHA256);
  assert.equal(sha256(revised), REVISED_PROMPT_SHA);
  assert.match(added, /smallest canonical operation set/);
  assert.match(added, /actually\n  consumed by its bound operation/);
  assert.match(added, /every parameter required by the frozen/);
  assert.match(added, /as one exact binding/);
  assert.doesNotMatch(added, /example\s*:|few[- ]?shot/i);
});

test('exact two-sided diff round-trips both prompt byte sequences', () => {
  const bytes = readBytes(DIFF_PATH);
  const artifact = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.at(-1), '}'.charCodeAt(0));
  assert.equal(bytes.toString('utf8'), JSON.stringify(artifact));
  assert.deepEqual(Object.keys(artifact), [
    'format', 'initial_utf8_base64', 'revised_utf8_base64'
  ]);
  assert.equal(artifact.format, 'planner-prompt-exact-diff-v0.1');
  assert.equal(sha256(bytes), DIFF_SHA);
  assert.deepEqual(Buffer.from(artifact.initial_utf8_base64, 'base64'),
    readBytes('prompts/planner-prototype-v0.1.txt'));
  assert.deepEqual(Buffer.from(artifact.revised_utf8_base64, 'base64'),
    readBytes(REVISED_PROMPT_PATH));
  assert.deepEqual(bytes,
    planner.exactPromptDiffBytes(readBytes(REVISED_PROMPT_PATH)));
});

test('revision passes full zero-shot admissibility with all counts at zero', () => {
  const decision = readJson(DECISION_PATH);
  const prompt = readBytes(REVISED_PROMPT_PATH);
  const denylist = revisionDenylist();
  const inspected = `${prompt.toString('utf8')}\n` +
    decision.general_revision_rationale;
  const normalized = inspected.normalize('NFC').toLowerCase();
  assert.equal(sha256(JSON.stringify(denylist)), DENYLIST_SHA);
  assert.equal(denylist.some((value) =>
    normalized.includes(value.normalize('NFC').toLowerCase())), false);
  assert.equal(planner.revisionAdmissible(
    prompt, decision.general_revision_rationale), true);
  assert.deepEqual(admissibilityCounts(
    prompt, decision.general_revision_rationale), {
    semantic_task_ids: 0,
    gold_operation_ids: 0,
    gold_requirement_ids: 0,
    oracle_actions: 0,
    expected_answers: 0,
    seed_specific_field_names: 0,
    task_specific_branching: 0,
    complete_gold_examples: 0,
    few_shot_examples: 0
  });
});

test('decision record freezes one serial exactly-once seven-run manifest', () => {
  const decision = readJson(DECISION_PATH);
  const assets = planner.loadPlannerAssets();
  assert.deepEqual(planner.schemaErrors(assets.revisionSchema, decision), []);
  assert.equal(decision.decision, 'ONE_GENERAL_REVISION');
  assert.equal(decision.initial_batch.failure_classification_sha256,
    CLASSIFICATION_SHA);
  assert.equal(decision.revised_prompt_sha256, REVISED_PROMPT_SHA);
  assert.equal(decision.prompt_diff_sha256, DIFF_SHA);
  assert.equal(decision.revision_admissibility.status, 'PASS');
  assert.equal(decision.revision_admissibility.denylist_sha256, DENYLIST_SHA);
  assert.equal(decision.revision_admissibility.zero_shot, true);
  assert.equal(decision.revised_batch.dispatch_policy,
    'FULL_SEVEN_SERIAL_NO_SELECTIVE_RERUN');
  assert.equal(decision.revised_batch.planned_runs.length, 7);
  assert.deepEqual(decision.revised_batch.planned_runs.map((run) => run.task_id),
    TASK_IDS);
  assert.ok(decision.revised_batch.planned_runs.every((run, index) =>
    run.run_order === index + 1 &&
    run.prompt_version === 'revised' &&
    run.prompt_sha256 === REVISED_PROMPT_SHA));
  assert.equal(new Set(decision.revised_batch.planned_runs.map((run) =>
    run.run_id)).size, 7);
  assert.equal(planner.revisedDispatchAllowed(
    decision,
    readBytes(REVISED_PROMPT_PATH),
    readBytes(DIFF_PATH),
    0,
    []
  ), true);
});

test('frozen spec, contracts, initial prompt, and implementation remain intact', () => {
  const integrity = planner.verifyFrozenIntegrity();
  assert.equal(integrity.ok, true);
  const sourceRoot = path.join(ROOT, 'artifacts', 'planner-prototype',
    'planner-prototype-v0.1-initial-deepseek-flash-20260918-02');
  const replayRoot = path.join(ROOT, 'artifacts', 'planner-prototype',
    'planner-prototype-v0.1-initial-deepseek-flash-20260918-02-' +
    'eval-replay-02');
  const replay = JSON.parse(fs.readFileSync(
    path.join(replayRoot, 'summary.json'), 'utf8'));
  assert.equal(replayRunner.sourceArtifactSetHash(sourceRoot),
    '6eb49786f7b0762a317741e7891c0bfdd0c6f5840f9561c2b3d6b65e8c97bd7f');
  const replayFiles = fs.readdirSync(path.join(replayRoot, 'runs')).sort();
  const replayArtifactSetHash = sha256(replayFiles.map((name) =>
    `${name}=${sha256(fs.readFileSync(path.join(replayRoot, 'runs', name)))}`
  ).join('\\n'));
  assert.equal(replayArtifactSetHash,
    '87613081d699d75886411cc668d702715db3cd5690fb3110de26290c171ad19f');
  const unhashedSummary = {...replay};
  delete unhashedSummary.summary_sha256;
  assert.equal(sha256(JSON.stringify(unhashedSummary)),
    'efdde98c6ac6a7d709d6f3720bdbf33d982a5d48180cc343c9ef421cc005cfd9');
  assert.equal(replay.source_artifact_set_sha256,
    '6eb49786f7b0762a317741e7891c0bfdd0c6f5840f9561c2b3d6b65e8c97bd7f');
  assert.equal(replay.replay_artifact_set_sha256,
    '87613081d699d75886411cc668d702715db3cd5690fb3110de26290c171ad19f');
  assert.equal(replay.summary_sha256,
    'efdde98c6ac6a7d709d6f3720bdbf33d982a5d48180cc343c9ef421cc005cfd9');
  assert.equal(replay.model_invoked, false);
  assert.equal(replay.zero_provider_dispatches, true);
});
