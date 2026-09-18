'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

const inputSchemaPath = path.join(
  ROOT, 'fixtures', 'planner-prototype-input-schema-v0.1.1.json');
const outputSchemaPath = path.join(
  ROOT, 'fixtures', 'planner-prototype-output-schema-v0.1.json');
const dev = loadJson('fixtures/planner-prototype-dev-cases-v0.1.1.json');
const priorDev = loadJson('fixtures/planner-prototype-dev-cases-v0.1.json');
const seeds = loadJson('fixtures/planner-seed-cases-v0.2.1.json');
const catalog = loadJson(
  'fixtures/planner-representation-catalog-v0.2.1.json');
const benchmark = loadJson('fixtures/md-bench-v0.2.json');
const contract = read('docs/planner-prototype-contract-v0.1.1.md');
const prompt = read('prompts/planner-prototype-v0.1.txt');

const SLOT_POOL = ['op.slot.001', 'op.slot.002', 'op.slot.003'];
const TASK_IDS = seeds.cases.map((item) => item.task_id);
const GOLD_OPERATION_IDS = seeds.cases.flatMap((item) =>
  item.planner_document.task_ir.operations.map((operation) =>
    operation.operation_id));
const PRIOR_SCHEMA_CONTEXT_IDS = priorDev.cases.flatMap((item) => [
  item.planner_input.abstract_data_schema.schema_id,
  ...item.planner_input.authority_context.sources.map((source) =>
    source.source_id)
]);
const TRUSTED_AUTHORITY = new Set([
  'USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA'
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateWithPowerShell(schemaPath, value) {
  const schema = schemaPath.replaceAll("'", "''");
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

function assertSchemaAccepts(schemaPath, value) {
  const result = validateWithPowerShell(schemaPath, value);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
}

function providerVisibleBytes(devCase) {
  return canonicalJson(devCase.planner_input);
}

function caseForTask(taskId) {
  return dev.cases.find((item) => item.evaluator_task_id === taskId);
}

function seedForTask(taskId) {
  return seeds.cases.find((item) => item.task_id === taskId);
}

function opaquePrediction(taskId) {
  const seedCase = seedForTask(taskId);
  const devCase = caseForTask(taskId);
  const prediction = {
    status: 'CONFIDENT',
    task_ir: clone(seedCase.planner_document.task_ir),
    requirements: clone(
      seedCase.planner_document.capability_requirements.requirements)
  };
  const operationIds = new Map();
  prediction.task_ir.operations.forEach((operation, index) => {
    operationIds.set(operation.operation_id, SLOT_POOL[index]);
  });
  for (const operation of prediction.task_ir.operations) {
    operation.operation_id = operationIds.get(operation.operation_id);
    operation.depends_on = operation.depends_on.map((ref) =>
      operationIds.get(ref));
  }
  const sourceIds = new Map();
  seedCase.trusted_context.sources.forEach((source, index) => {
    sourceIds.set(
      source.source_id,
      devCase.planner_input.authority_context.sources[index].source_id
    );
  });
  for (const requirement of prediction.requirements) {
    requirement.operation_ref = operationIds.get(requirement.operation_ref);
    requirement.authority_witness.source_id =
      sourceIds.get(requirement.authority_witness.source_id);
    if (requirement.authority_witness.support_type === 'OPERATION') {
      requirement.authority_witness.support_ref =
        operationIds.get(requirement.authority_witness.support_ref);
    }
  }
  return prediction;
}

function operationMap(prediction) {
  return new Map(prediction.task_ir.operations.map((operation) => [
    operation.operation_id, operation
  ]));
}

function sourceMap(plannerInput) {
  return new Map(plannerInput.authority_context.sources.map((source) => [
    source.source_id, source
  ]));
}

function exactOperationInput(operation, target) {
  return operation.inputs.some((input) =>
    canonicalJson(input) === canonicalJson(target));
}

function collectStrings(value, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, result));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, result));
  } else if (typeof value === 'string') {
    result.add(value);
  }
  return result;
}

function slotPolicyValid(plannerInput, prediction) {
  const operations = prediction.task_ir.operations;
  const slots = plannerInput.operation_slot_policy.slots;
  if (operations.length > slots.length) return false;
  if (new Set(operations.map((item) => item.operation_id)).size !==
      operations.length) return false;
  if (!operations.every((operation, index) =>
    operation.operation_id === slots[index])) return false;
  const used = new Set(operations.map((item) => item.operation_id));
  return prediction.requirements.every((requirement) =>
    used.has(requirement.operation_ref));
}

function authorityWitnessValid(plannerInput, prediction, requirement) {
  const witness = requirement.authority_witness;
  const source = sourceMap(plannerInput).get(witness.source_id);
  if (!source || !TRUSTED_AUTHORITY.has(source.authority_class)) return false;
  if (source.authority_class !== witness.authority_class) return false;
  if (!source.supports.some((support) =>
    support.support_type === witness.support_type &&
    support.support_ref === witness.support_ref)) return false;

  const operation = operationMap(prediction).get(requirement.operation_ref);
  if (!operation) return false;
  if (!requirement.targets.every((target) =>
    exactOperationInput(operation, target))) return false;

  if (witness.support_type === 'OPERATION') {
    return witness.authority_class === 'USER_INTENT' &&
      witness.support_ref === requirement.operation_ref &&
      requirement.boundary === 'AGENT';
  }
  if (witness.support_type === 'SCHEMA_FIELD') {
    return witness.authority_class === 'DATA_SCHEMA' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' &&
      requirement.targets.some((target) =>
        target.field_ref === witness.support_ref);
  }
  if (witness.support_type === 'WORKFLOW_RULE') {
    const references = collectStrings({
      capability: requirement.capability.parameters,
      operation: operation.parameters
    });
    return witness.authority_class === 'TRUSTED_WORKFLOW' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' &&
      references.has(witness.support_ref);
  }
  if (witness.support_type === 'SOURCE_RELATION') {
    const roles = new Set(['RELATION_SOURCE', 'RELATION_TARGET']);
    return witness.authority_class === 'DATA_SCHEMA' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind === 'DECLARED_RELATION_SET' &&
      requirement.scope.reference === witness.support_ref &&
      ['existing_relation', 'directionality'].includes(
        requirement.capability.name) &&
      requirement.targets.every((target) => roles.has(target.target_role));
  }
  if (witness.support_type === 'TOOL_PARAMETER') {
    const parameterExists = plannerInput.trusted_tool_schema.tools.some(
      (tool) => tool.parameters.some((parameter) =>
        parameter.parameter_ref === witness.support_ref &&
        parameter.source_field_ref === requirement.targets[0]?.field_ref)
    );
    return witness.authority_class === 'TOOL_SCHEMA' &&
      operation.family === 'tool_call' &&
      operation.role === 'TOOL_EXECUTION' &&
      requirement.boundary === 'TOOL' &&
      requirement.scope.kind === 'DECLARED_TOOL_ARGUMENT' &&
      requirement.scope.reference === witness.support_ref &&
      requirement.targets.length === 1 &&
      requirement.targets[0].target_role === 'TOOL_ARGUMENT' &&
      parameterExists;
  }
  return false;
}

function permutations(values) {
  if (values.length <= 1) return [values];
  const result = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of permutations(rest)) result.push([value, ...suffix]);
  });
  return result;
}

function normalizedUnderMapping(document, requirements, labels) {
  const operations = document.operations;
  const mapping = new Map(operations.map((operation, index) => [
    operation.operation_id, labels[index]
  ]));
  const normalizedOperations = operations.map((operation) => {
    const normalized = clone(operation);
    normalized.operation_id = mapping.get(operation.operation_id);
    normalized.depends_on = normalized.depends_on.map((ref) =>
      mapping.get(ref)).sort();
    return normalized;
  }).sort((left, right) =>
    left.operation_id.localeCompare(right.operation_id));

  const normalizedRequirements = requirements.map((requirement) => {
    const normalized = clone(requirement);
    delete normalized.requirement_id;
    normalized.operation_ref = mapping.get(requirement.operation_ref);
    delete normalized.authority_witness.source_id;
    if (normalized.authority_witness.support_type === 'OPERATION') {
      normalized.authority_witness.support_ref =
        mapping.get(normalized.authority_witness.support_ref);
    }
    return normalized;
  }).sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));

  const presentation = document.presentation.map((item) => {
    const normalized = clone(item);
    delete normalized.constraint_id;
    return normalized;
  }).sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));

  return canonicalJson({
    task_ir_version: document.task_ir_version,
    operations: normalizedOperations,
    presentation,
    requirements: normalizedRequirements
  });
}

function alphaCanonical(document, requirements) {
  const labels = document.operations.map((unused, index) =>
    'op.alpha.' + String(index + 1).padStart(3, '0'));
  return permutations(labels)
    .map((permutation) =>
      normalizedUnderMapping(document, requirements, permutation))
    .sort()[0];
}

function capabilitySemantic(name) {
  return catalog.capability_semantics.find((item) => item.name === name);
}

function coverageCapabilityMatches(coverage, requirement) {
  if (coverage.capability === requirement.capability.name) return true;
  const semantic = capabilitySemantic(coverage.capability);
  return Boolean(semantic?.entails.includes(requirement.capability.name));
}

function dimensionMatchesRequirement(dimension, operation, requirement) {
  if (!requirement.targets.every((target) =>
    dimension.target_fields.some((field) =>
      field.field_ref === target.field_ref &&
      field.semantic_type === target.semantic_type))) return false;
  if (!dimension.operation_bindings.some((binding) =>
    binding.operation_families.includes(operation.family) &&
    binding.operation_roles.includes(operation.role))) return false;
  return dimension.candidate_actions.some((action) =>
    action.coverage.some((coverage) =>
      coverageCapabilityMatches(coverage, requirement) &&
      canonicalJson(coverage.parameters) ===
        canonicalJson(requirement.capability.parameters) &&
      coverage.boundary === requirement.boundary));
}

function trustedClaims(trustedContext) {
  return new Set(trustedContext.sources
    .filter((source) => TRUSTED_AUTHORITY.has(source.authority_class))
    .flatMap((source) => source.claims.map((claim) => claim.claim_id)));
}

function actionSatisfies(action, requirements, claims) {
  return requirements.every((requirement) =>
    action.coverage.some((coverage) =>
      coverageCapabilityMatches(coverage, requirement) &&
      canonicalJson(coverage.parameters) ===
        canonicalJson(requirement.capability.parameters) &&
      coverage.boundary === requirement.boundary &&
      coverage.required_preconditions.every((claim) => claims.has(claim))));
}

function qualifyPrediction(prediction, trustedContext, trustedCatalogSlice) {
  const operations = operationMap(prediction);
  const dimensions = trustedCatalogSlice.dimension_refs.map((ref) =>
    catalog.dimensions.find((dimension) => dimension.dimension_ref === ref));
  if (dimensions.some((dimension) => !dimension)) {
    return {status: 'INFEASIBLE', reason: 'MISSING_DIMENSION'};
  }

  const mapping = new Map();
  for (const requirement of prediction.requirements) {
    const operation = operations.get(requirement.operation_ref);
    if (!operation) return {status: 'INFEASIBLE', reason: 'NO_OPERATION'};
    const matches = dimensions.filter((dimension) =>
      dimensionMatchesRequirement(dimension, operation, requirement));
    if (matches.length !== 1) {
      return {
        status: 'INFEASIBLE',
        reason: matches.length ? 'AMBIGUOUS_MAPPING' : 'NO_COVERAGE'
      };
    }
    const ref = matches[0].dimension_ref;
    if (!mapping.has(ref)) mapping.set(ref, []);
    mapping.get(ref).push(requirement);
  }

  const claims = trustedClaims(trustedContext);
  const selectedPlan = [];
  for (const dimension of dimensions) {
    const requirements = mapping.get(dimension.dimension_ref) || [];
    const action = [...dimension.candidate_actions]
      .sort((left, right) => left.level - right.level)
      .find((candidate) => actionSatisfies(
        candidate, requirements, claims));
    if (!action) {
      return {status: 'INFEASIBLE', reason: 'NO_FEASIBLE_ACTION'};
    }
    selectedPlan.push({
      dimension_ref: dimension.dimension_ref,
      transformation_id: action.transformation_id
    });
  }
  return {status: 'FEASIBLE', selected_plan: selectedPlan};
}

test('all seven final provider projections validate and remain raw-blind', () => {
  assert.equal(dev.dev_fixture_version,
    'planner-prototype-dev-cases-v0.1.1');
  assert.equal(dev.model_visible_projection, 'cases[].planner_input');
  assert.equal(dev.cases.length, 7);
  for (const devCase of dev.cases) {
    assertSchemaAccepts(inputSchemaPath, devCase.planner_input);
    const bytes = providerVisibleBytes(devCase);
    for (const task of benchmark.tasks) {
      for (const entity of task.sensitive_entities) {
        assert.equal(bytes.includes(entity.raw_value), false,
          devCase.case_id + '/' + entity.occurrence_id);
      }
    }
    for (const forbiddenKey of [
      'task_id', 'case_id', 'evaluator_task_id', 'ground_truth', 'oracle',
      'oracle_bridge', 'planner_document', 'capability_requirements',
      'expected_reporting_plan', 'exposure', 'correctness'
    ]) {
      assert.equal(bytes.includes('"' + forbiddenKey + '"'), false,
        devCase.case_id + '/' + forbiddenKey);
    }
  }
});

test('canonical provider bytes expose zero semantic task or Gold operation IDs', () => {
  for (const devCase of dev.cases) {
    const bytes = providerVisibleBytes(devCase);
    assert.equal(/MD-[A-Z]+-[0-9]{2}/.test(bytes), false,
      devCase.case_id + '/semantic-task-pattern');
    for (const value of [
      ...TASK_IDS,
      ...GOLD_OPERATION_IDS,
      ...PRIOR_SCHEMA_CONTEXT_IDS
    ]) {
      assert.equal(bytes.includes(value), false,
        devCase.case_id + '/' + value);
    }
    assert.equal(bytes.includes('"schema_id":"schema.001"'), true);
    assert.equal(/"source_id":"ctx\.slot\.[0-9]{3}"/.test(bytes), true);
    const operationLikeStrings = [];
    const collect = (value) => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
      } else if (typeof value === 'string' && value.startsWith('op.')) {
        operationLikeStrings.push(value);
      }
    };
    collect(devCase.planner_input);
    assert.equal(operationLikeStrings.every((value) =>
      SLOT_POOL.includes(value)), true, devCase.case_id);
  }
});

test('operation pool and USER_INTENT supports are identical for all cases', () => {
  const poolBytes = new Set();
  const supportBytes = new Set();
  for (const devCase of dev.cases) {
    const input = devCase.planner_input;
    assert.deepEqual(input.operation_slot_policy, {
      assignment_rule: 'TASK_IR_ARRAY_ORDER_SMALLEST_AVAILABLE',
      slots: SLOT_POOL
    });
    poolBytes.add(JSON.stringify(input.operation_slot_policy.slots));
    const userIntent = input.authority_context.sources.find((source) =>
      source.authority_class === 'USER_INTENT');
    assert.ok(userIntent);
    const expected = SLOT_POOL.map((slot) => ({
      support_type: 'OPERATION',
      support_ref: slot
    }));
    assert.deepEqual(userIntent.supports, expected);
    supportBytes.add(JSON.stringify(userIntent.supports));
  }
  assert.equal(poolBytes.size, 1);
  assert.equal(supportBytes.size, 1);
  assert.deepEqual(
    seeds.cases.map((item) => item.planner_document.task_ir.operations.length),
    [1, 2, 1, 2, 2, 3, 2]
  );
});

test('opaque Gold-shaped outputs satisfy reused output schema and slot policy', () => {
  assert.equal(fs.existsSync(path.join(
    ROOT, 'fixtures', 'planner-prototype-output-schema-v0.1.1.json')), false);
  for (const taskId of TASK_IDS) {
    const prediction = opaquePrediction(taskId);
    assertSchemaAccepts(outputSchemaPath, prediction);
    assert.equal(slotPolicyValid(
      caseForTask(taskId).planner_input, prediction), true, taskId);
    assert.deepEqual(
      prediction.task_ir.operations.map((item) => item.operation_id),
      SLOT_POOL.slice(0, prediction.task_ir.operations.length)
    );
  }
});

test('opaque Gold-shaped outputs pass unchanged authority compatibility', () => {
  for (const taskId of TASK_IDS) {
    const plannerInput = caseForTask(taskId).planner_input;
    const prediction = opaquePrediction(taskId);
    for (const requirement of prediction.requirements) {
      assert.equal(
        authorityWitnessValid(plannerInput, prediction, requirement),
        true,
        taskId + '/' + requirement.requirement_id
      );
    }
  }
});

test('authority rejects nonexistent, unused, forged, and wrong-class handles', () => {
  const plannerInput = caseForTask('MD-EQ-01').planner_input;

  const nonexistent = opaquePrediction('MD-EQ-01');
  nonexistent.task_ir.operations[0].operation_id = 'op.slot.999';
  nonexistent.requirements[0].operation_ref = 'op.slot.999';
  nonexistent.requirements[0].authority_witness.support_ref = 'op.slot.999';
  assert.equal(slotPolicyValid(plannerInput, nonexistent), false);
  assert.equal(authorityWitnessValid(
    plannerInput, nonexistent, nonexistent.requirements[0]), false);

  const unused = opaquePrediction('MD-EQ-01');
  unused.requirements[0].operation_ref = 'op.slot.003';
  unused.requirements[0].authority_witness.support_ref = 'op.slot.003';
  assert.equal(slotPolicyValid(plannerInput, unused), false);
  assert.equal(authorityWitnessValid(
    plannerInput, unused, unused.requirements[0]), false);

  const forged = opaquePrediction('MD-EQ-01');
  forged.requirements[0].authority_witness.source_id = 'ctx.slot.999';
  assert.equal(authorityWitnessValid(
    plannerInput, forged, forged.requirements[0]), false);

  const wrongClass = opaquePrediction('MD-EQ-01');
  wrongClass.requirements[0].authority_witness.authority_class =
    'DATA_SCHEMA';
  assert.equal(authorityWitnessValid(
    plannerInput, wrongClass, wrongClass.requirements[0]), false);
});

test('trusted but unrelated workflow and Tool supports still reject', () => {
  const locInput = clone(caseForTask('MD-LOC-04').planner_input);
  const locPrediction = opaquePrediction('MD-LOC-04');
  locInput.authority_context.sources.push({
    source_id: 'ctx.slot.999',
    authority_class: 'TRUSTED_WORKFLOW',
    supports: [{
      support_type: 'WORKFLOW_RULE',
      support_ref: 'workflow.unrelated'
    }]
  });
  locPrediction.requirements[0].authority_witness = {
    source_id: 'ctx.slot.999',
    authority_class: 'TRUSTED_WORKFLOW',
    support_type: 'WORKFLOW_RULE',
    support_ref: 'workflow.unrelated'
  };
  assert.equal(authorityWitnessValid(
    locInput, locPrediction, locPrediction.requirements[0]), false);

  const toolInput = clone(caseForTask('MD-TOOL-07').planner_input);
  const toolPrediction = opaquePrediction('MD-TOOL-07');
  toolInput.authority_context.sources.push({
    source_id: 'ctx.slot.999',
    authority_class: 'TOOL_SCHEMA',
    supports: [{
      support_type: 'TOOL_PARAMETER',
      support_ref: 'tool.dispatch_visit.unrelated'
    }]
  });
  toolPrediction.requirements[0].authority_witness = {
    source_id: 'ctx.slot.999',
    authority_class: 'TOOL_SCHEMA',
    support_type: 'TOOL_PARAMETER',
    support_ref: 'tool.dispatch_visit.unrelated'
  };
  assert.equal(authorityWitnessValid(
    toolInput, toolPrediction, toolPrediction.requirements[0]), false);
});

test('canonical comparison is invariant to opaque local identifiers', () => {
  for (const seedCase of seeds.cases) {
    const prediction = opaquePrediction(seedCase.task_id);
    assert.equal(
      alphaCanonical(prediction.task_ir, prediction.requirements),
      alphaCanonical(
        seedCase.planner_document.task_ir,
        seedCase.planner_document.capability_requirements.requirements
      ),
      seedCase.task_id
    );
  }
});

test('compiler qualification remains feasible and Oracle-exact', () => {
  for (const seedCase of seeds.cases) {
    const result = qualifyPrediction(
      opaquePrediction(seedCase.task_id),
      seedCase.trusted_context,
      seedCase.trusted_catalog_slice
    );
    assert.equal(result.status, 'FEASIBLE', seedCase.task_id);
    assert.deepEqual(
      result.selected_plan,
      seedCase.oracle_bridge.expected_reporting_plan,
      seedCase.task_id
    );
  }
});

test('v0.1 prompt, output schema, and artifact schema are reused unchanged', () => {
  assert.equal(
    sha256(prompt),
    '6832acad77c8182be79bd2aec8f278eb533261bbf939108b5cf52f4a4ac66a5d'
  );
  for (const relativePath of [
    'prompts/planner-prototype-v0.1.txt',
    'fixtures/planner-prototype-output-schema-v0.1.json',
    'fixtures/planner-prototype-artifact-schema-v0.1.json'
  ]) {
    const result = spawnSync('git', [
      'diff', '--exit-code', 'planner-prototype-contract-v0.1^{commit}',
      '--', relativePath
    ], {cwd: ROOT, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('frozen v0.1 and planner-spec-v0.2.1 provenance remain intact', () => {
  const refs = [
    ['planner-prototype-contract-v0.1^{commit}',
      'adef3313f8dd4ff927ceadb4bff8de9855fd3d12'],
    ['planner-prototype-contract-v0.1^{tag}',
      '9062086af82b81e52829ab3bbd8fefe3e4278164'],
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
});

test('patch scope and secret scan remain closed', () => {
  for (const phrase of [
    'op.slot.001',
    'smallest common upper bound',
    'Every USER_INTENT source exposes the same three OPERATION supports',
    'Identifier-independent Gold comparison',
    'no Planner implementation',
    'no live inference',
    'no research result'
  ]) assert.equal(contract.includes(phrase), true, phrase);

  const text = [
    contract,
    read('fixtures/planner-prototype-input-schema-v0.1.1.json'),
    read('fixtures/planner-prototype-dev-cases-v0.1.1.json'),
    read('tests/planner-prototype-contract-v0.1.1.test.js')
  ].join('\n');
  for (const marker of [
    'sk-' + 'live',
    'Bearer ' + 'eyJ',
    'DEEPSEEK_API_KEY' + '=',
    'OPENAI_API_KEY' + '='
  ]) assert.equal(text.includes(marker), false, marker);
  assert.equal(fs.existsSync(path.join(
    ROOT, 'src', 'planner-prototype-v0.1.1.js')), false);
});
