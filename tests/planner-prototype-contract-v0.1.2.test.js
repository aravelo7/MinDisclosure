'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const loadJson = (relativePath) => JSON.parse(read(relativePath));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

const decisionSchemaPath = path.join(
  ROOT,
  'fixtures',
  'planner-prototype-development-revision-schema-v0.1.2.json'
);
const initialPrompt = read('prompts/planner-prototype-v0.1.txt');
const dev = loadJson('fixtures/planner-prototype-dev-cases-v0.1.1.json');
const seeds = loadJson('fixtures/planner-seed-cases-v0.2.1.json');
const benchmark = loadJson('fixtures/md-bench-v0.2.json');
const artifactSchema = loadJson(
  'fixtures/planner-prototype-artifact-schema-v0.1.json');
const contract = read('docs/planner-prototype-contract-v0.1.2.md');

const INITIAL_PROMPT_SHA =
  '6832acad77c8182be79bd2aec8f278eb533261bbf939108b5cf52f4a4ac66a5d';
const TASK_IDS = [
  'MD-EQ-01', 'MD-GROUP-02', 'MD-ORDER-03', 'MD-LOC-04',
  'MD-CROSS-05', 'MD-GRAPH-06', 'MD-TOOL-07'
];
const INITIAL_RUN_IDS = TASK_IDS.map((taskId, index) =>
  'planner-dev-v0.1/initial/' +
  String(index + 1).padStart(3, '0') + '/' + taskId);
const REVISED_RUN_IDS = TASK_IDS.map((taskId, index) =>
  'planner-dev-v0.1/revised/' +
  String(index + 1).padStart(3, '0') + '/' + taskId);

function validateWithPowerShell(value) {
  const schema = decisionSchemaPath.replaceAll("'", "''");
  const json = JSON.stringify(value).replaceAll("'", "''");
  const script = [
    "$schema='" + schema + "'",
    "$json='" + json + "'",
    'if(-not ($json | Test-Json -SchemaFile $schema)){ exit 2 }'
  ].join('; ');
  return spawnSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

function assertSchemaAccepts(value) {
  const result = validateWithPowerShell(value);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
}

function assertSchemaRejects(value) {
  const result = validateWithPowerShell(value);
  assert.notEqual(result.status, 0, 'schema unexpectedly accepted record');
}

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

const DENYLIST = revisionDenylist();
const DENYLIST_SHA = sha256(JSON.stringify(DENYLIST));

function inspectText(value) {
  return value.normalize('NFC').toLowerCase();
}

function revisionAdmissible(revisedPrompt, rationale) {
  if (!Buffer.isBuffer(revisedPrompt)) return false;
  if (revisedPrompt.equals(Buffer.from(initialPrompt, 'utf8'))) return false;
  const texts = [
    inspectText(revisedPrompt.toString('utf8')),
    inspectText(rationale)
  ];
  for (const text of texts) {
    if (DENYLIST.some((value) =>
      text.includes(inspectText(value)))) return false;
    if (/\b(eq|group|order|loc|cross|graph|tool)\s+(task|case)\b/i
      .test(text)) return false;
    if (/\b(example\s*:|few[- ]?shot)\b/i.test(text)) return false;
    if (/"task_ir"\s*:/i.test(text) &&
        /"requirements"\s*:/i.test(text)) return false;
  }
  return true;
}

function exactDiffBytes(revisedPrompt) {
  const artifact = {
    format: 'planner-prompt-exact-diff-v0.1',
    initial_utf8_base64: Buffer.from(initialPrompt, 'utf8').toString('base64'),
    revised_utf8_base64: revisedPrompt.toString('base64')
  };
  return Buffer.from(JSON.stringify(artifact), 'utf8');
}

function revisedRuns(promptSha) {
  return TASK_IDS.map((taskId, index) => ({
    run_id: REVISED_RUN_IDS[index],
    run_order: index + 1,
    task_id: taskId,
    prompt_version: 'revised',
    prompt_sha256: promptSha
  }));
}

function initialBatch() {
  return {
    completed: true,
    run_ids: INITIAL_RUN_IDS,
    failure_classification_sha256: 'c'.repeat(64)
  };
}

function noRevisionRecord() {
  return {
    contract_version: 'planner-prototype-contract-v0.1.2',
    decision: 'NO_REVISION',
    initial_prompt_sha256: INITIAL_PROMPT_SHA,
    initial_batch: initialBatch(),
    general_revision_rationale: null,
    revised_prompt_sha256: null,
    prompt_diff_sha256: null,
    prompt_diff_format: null,
    revision_decided_after_initial_batch: true,
    revised_prompt_frozen_before_first_dispatch: null,
    revised_prompt_artifact: null,
    revision_admissibility: null,
    revised_batch: null
  };
}

function oneRevisionRecord(revisedPrompt, rationale) {
  const promptSha = sha256(revisedPrompt);
  return {
    contract_version: 'planner-prototype-contract-v0.1.2',
    decision: 'ONE_GENERAL_REVISION',
    initial_prompt_sha256: INITIAL_PROMPT_SHA,
    initial_batch: initialBatch(),
    general_revision_rationale: rationale,
    revised_prompt_sha256: promptSha,
    prompt_diff_sha256: sha256(exactDiffBytes(revisedPrompt)),
    prompt_diff_format: 'planner-prompt-exact-diff-v0.1',
    revision_decided_after_initial_batch: true,
    revised_prompt_frozen_before_first_dispatch: true,
    revised_prompt_artifact: {
      path: 'prompts/planner-prototype-v0.1-revised.txt',
      diff_path:
        'artifacts/planner-development/' +
        'planner-prototype-v0.1-prompt-exact-diff.json'
    },
    revision_admissibility: {
      status: 'PASS',
      denylist_sha256: DENYLIST_SHA,
      zero_shot: true
    },
    revised_batch: {
      dispatch_policy: 'FULL_SEVEN_SERIAL_NO_SELECTIVE_RERUN',
      planned_runs: revisedRuns(promptSha)
    }
  };
}

function exactBatchPlan(record) {
  if (!record.revised_batch) return false;
  const runs = record.revised_batch.planned_runs;
  if (runs.length !== 7) return false;
  return runs.every((run, index) =>
    run.run_id === REVISED_RUN_IDS[index] &&
    run.run_order === index + 1 &&
    run.task_id === TASK_IDS[index] &&
    run.prompt_version === 'revised' &&
    run.prompt_sha256 === record.revised_prompt_sha256);
}

function revisedDispatchAllowed(
  record,
  revisedPrompt,
  diffBytes,
  nextRunIndex,
  priorPromptHashes
) {
  if (record.decision !== 'ONE_GENERAL_REVISION') return false;
  if (!record.initial_batch.completed ||
      record.initial_batch.run_ids.length !== 7) return false;
  if (!record.revision_decided_after_initial_batch ||
      !record.revised_prompt_frozen_before_first_dispatch) return false;
  if (sha256(revisedPrompt) !== record.revised_prompt_sha256) return false;
  if (sha256(diffBytes) !== record.prompt_diff_sha256) return false;
  if (!revisionAdmissible(
    revisedPrompt, record.general_revision_rationale)) return false;
  if (!exactBatchPlan(record)) return false;
  if (nextRunIndex !== priorPromptHashes.length ||
      nextRunIndex < 0 || nextRunIndex >= 7) return false;
  if (!priorPromptHashes.every((hash) =>
    hash === record.revised_prompt_sha256)) return false;
  return record.revised_batch.planned_runs[nextRunIndex].prompt_sha256 ===
    record.revised_prompt_sha256;
}

const GENERAL_RATIONALE =
  'Clarify that operation identifiers must be allocated from the opaque ' +
  'slot pool in Task IR array order.';
const SCRIPTED_REVISED_PROMPT = Buffer.from(
  initialPrompt +
  '\nGeneral rule: Allocate operation identifiers from the supplied opaque ' +
  'slot pool in Task IR array order.\n',
  'utf8'
);

test('initial prompt bytes and SHA-256 remain frozen', () => {
  assert.equal(sha256(Buffer.from(initialPrompt, 'utf8')),
    INITIAL_PROMPT_SHA);
  const result = spawnSync('git', [
    'diff', '--exit-code', 'planner-prototype-contract-v0.1.1^{commit}',
    '--', 'prompts/planner-prototype-v0.1.txt'
  ], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('NO_REVISION is valid only after complete initial classification', () => {
  const record = noRevisionRecord();
  assertSchemaAccepts(record);
  assert.equal(revisedDispatchAllowed(
    record, SCRIPTED_REVISED_PROMPT,
    exactDiffBytes(SCRIPTED_REVISED_PROMPT), 0, []), false);

  const incomplete = clone(record);
  incomplete.initial_batch.completed = false;
  assertSchemaRejects(incomplete);

  const fabricated = clone(record);
  fabricated.revised_prompt_sha256 = 'a'.repeat(64);
  assertSchemaRejects(fabricated);
});

test('ONE_GENERAL_REVISION freezes prompt and exact diff before dispatch', () => {
  const record = oneRevisionRecord(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE);
  const diffBytes = exactDiffBytes(SCRIPTED_REVISED_PROMPT);
  assertSchemaAccepts(record);
  assert.equal(revisionAdmissible(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE), true);
  assert.equal(record.revised_prompt_sha256,
    sha256(SCRIPTED_REVISED_PROMPT));
  assert.equal(record.prompt_diff_sha256, sha256(diffBytes));
  const decoded = JSON.parse(diffBytes.toString('utf8'));
  assert.deepEqual(
    Buffer.from(decoded.initial_utf8_base64, 'base64'),
    Buffer.from(initialPrompt, 'utf8')
  );
  assert.deepEqual(
    Buffer.from(decoded.revised_utf8_base64, 'base64'),
    SCRIPTED_REVISED_PROMPT
  );
  assert.equal(revisedDispatchAllowed(
    record, SCRIPTED_REVISED_PROMPT, diffBytes, 0, []), true);
});

test('revised dispatch rejects missing or incomplete freeze provenance', () => {
  const record = oneRevisionRecord(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE);
  const diffBytes = exactDiffBytes(SCRIPTED_REVISED_PROMPT);

  const missingHash = clone(record);
  delete missingHash.revised_prompt_sha256;
  assertSchemaRejects(missingHash);
  assert.equal(revisedDispatchAllowed(
    missingHash, SCRIPTED_REVISED_PROMPT, diffBytes, 0, []), false);

  const notFrozen = clone(record);
  notFrozen.revised_prompt_frozen_before_first_dispatch = false;
  assertSchemaRejects(notFrozen);
  assert.equal(revisedDispatchAllowed(
    notFrozen, SCRIPTED_REVISED_PROMPT, diffBytes, 0, []), false);

  const decidedEarly = clone(record);
  decidedEarly.revision_decided_after_initial_batch = false;
  assertSchemaRejects(decidedEarly);
  assert.equal(revisedDispatchAllowed(
    decidedEarly, SCRIPTED_REVISED_PROMPT, diffBytes, 0, []), false);
});

test('all seven revised identities use one immutable prompt hash', () => {
  const record = oneRevisionRecord(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE);
  const diffBytes = exactDiffBytes(SCRIPTED_REVISED_PROMPT);
  const history = [];
  for (let index = 0; index < 7; index += 1) {
    assert.equal(revisedDispatchAllowed(
      record, SCRIPTED_REVISED_PROMPT, diffBytes, index, history), true);
    history.push(record.revised_prompt_sha256);
  }
  assert.deepEqual(
    record.revised_batch.planned_runs.map((run) => run.run_id),
    REVISED_RUN_IDS
  );
  assert.equal(new Set(history).size, 1);
});

test('revised prompt mutation after first dispatch rejects', () => {
  const record = oneRevisionRecord(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE);
  const diffBytes = exactDiffBytes(SCRIPTED_REVISED_PROMPT);
  const history = [record.revised_prompt_sha256];
  const mutated = Buffer.concat([
    SCRIPTED_REVISED_PROMPT,
    Buffer.from('\nAnother rule.\n', 'utf8')
  ]);
  assert.equal(revisedDispatchAllowed(
    record, mutated, diffBytes, 1, history), false);
});

test('task-local prompt variants and selective revised reruns reject', () => {
  const record = oneRevisionRecord(
    SCRIPTED_REVISED_PROMPT, GENERAL_RATIONALE);
  const variant = clone(record);
  variant.revised_batch.planned_runs[3].prompt_sha256 = 'd'.repeat(64);
  assertSchemaAccepts(variant);
  assert.equal(exactBatchPlan(variant), false);

  const selective = clone(record);
  selective.revised_batch.planned_runs =
    selective.revised_batch.planned_runs.slice(0, 2);
  assertSchemaRejects(selective);
  assert.equal(exactBatchPlan(selective), false);
});

test('seed-specific rationale and branching reject', () => {
  for (const rationale of [
    'GROUP task should use domain.',
    'GRAPH case should output two operations.',
    'Special-case MD-GROUP-02.',
    'For invoices.contact_email use the domain.'
  ]) {
    assert.equal(revisionAdmissible(
      SCRIPTED_REVISED_PROMPT, rationale), false, rationale);
  }
});

test('Gold, Oracle, answer, and few-shot leakage reject', () => {
  const forbiddenAdditions = [
    'Use MD-GROUP-02.',
    'Use op.group_by_domain.',
    'Emit req.group.domain.',
    'Select transformation DOMAIN_HANDLE.',
    'Expected answer contains r1.',
    'Read records.email.',
    'Example: {"task_ir":{},"requirements":[]}'
  ];
  for (const addition of forbiddenAdditions) {
    const candidate = Buffer.from(
      initialPrompt + '\n' + addition + '\n', 'utf8');
    assert.equal(revisionAdmissible(
      candidate, GENERAL_RATIONALE), false, addition);
  }
});

test('existing run artifacts can record revised version and prompt hash', () => {
  const promptVersions =
    artifactSchema.properties.run_identity.properties.prompt_version.enum;
  assert.deepEqual(promptVersions, ['initial', 'revised']);
  assert.ok(artifactSchema.properties.provenance.properties.prompt_sha256);
  assert.equal(
    artifactSchema.properties.run_identity.properties.run_id.pattern,
    '^planner-dev-v0\\.1\\/(initial|revised)\\/[0-9]{3}\\/[A-Z0-9-]+$'
  );
});

test('v0.1.1 P0 and Planner Spec provenance remain intact', () => {
  const refs = [
    ['planner-prototype-contract-v0.1.1^{commit}',
      '8d3aeb616a75f20d72a920e6240ed716c6cd8ace'],
    ['planner-prototype-contract-v0.1.1^{tag}',
      '66377fc8cf451313c2c6ca5d27f0b81271dba54b'],
    ['planner-prototype-contract-v0.1.1^{tree}',
      '11994550cc464ec38df5812265a875abd354980c'],
    ['planner-spec-v0.2.1^{commit}',
      '6b152f738e8b4f1d4a0186a36bb7466e40de88db'],
    ['planner-spec-v0.2.1^{tag}',
      '3b45322d29454134aff345b2413121f1b37008fa'],
    ['planner-spec-v0.2.1^{tree}',
      '54f4dc2d52af0ef3e1402528b510e6c91463b6fa']
  ];
  for (const [ref, expected] of refs) {
    const result = spawnSync('git', ['rev-parse', ref], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, ref);
  }
  for (const relativePath of [
    'docs/planner-prototype-contract-v0.1.1.md',
    'fixtures/planner-prototype-input-schema-v0.1.1.json',
    'fixtures/planner-prototype-dev-cases-v0.1.1.json',
    'tests/planner-prototype-contract-v0.1.1.test.js'
  ]) {
    const result = spawnSync('git', [
      'diff', '--exit-code', 'planner-prototype-contract-v0.1.1^{commit}',
      '--', relativePath
    ], {cwd: ROOT, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('contract scope is closed and no real revised prompt exists', () => {
  assert.equal(fs.existsSync(path.join(
    ROOT, 'prompts', 'planner-prototype-v0.1-revised.txt')), false);
  for (const phrase of [
    'NO_REVISION',
    'ONE_GENERAL_REVISION',
    'prompt_diff_sha256',
    'Immediately before every revised HTTP/provider dispatch',
    'Best-of-N, selective rerun',
    'no real revised prompt',
    'no Planner implementation',
    'no initial or revised dev inference'
  ]) assert.equal(contract.includes(phrase), true, phrase);

  const patchText = [
    contract,
    read('fixtures/planner-prototype-development-revision-schema-v0.1.2.json'),
    read('tests/planner-prototype-contract-v0.1.2.test.js')
  ].join('\n');
  for (const marker of [
    'sk-' + 'live',
    'Bearer ' + 'eyJ',
    'DEEPSEEK_API_KEY' + '=',
    'OPENAI_API_KEY' + '='
  ]) assert.equal(patchText.includes(marker), false, marker);
  assert.equal(fs.existsSync(path.join(
    ROOT, 'src', 'planner-prototype-v0.1.2.js')), false);
});
