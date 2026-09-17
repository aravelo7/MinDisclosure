'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

const schema = loadJson('fixtures/planner-capability-schema-v0.2.json');
const seeds = loadJson('fixtures/planner-seed-cases-v0.2.json');
const catalog = loadJson('fixtures/planner-representation-catalog-v0.2.json');
const negatives = loadJson('fixtures/planner-negative-cases-v0.2.json');
const frozen = loadJson('fixtures/md-bench-v0.2.json');
const oldSearchSpace = loadJson('fixtures/md-bench-v0.2-search-space.json');

const TRUSTED_AUTHORITY = new Set(['USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA']);
const ERROR_PRECEDENCE = [
  'ANSWER_LEAKAGE',
  'AUTHORITY_VIOLATION',
  'SEMANTIC_INVALID',
  'WRONG_OPERATION_BINDING',
  'WRONG_TARGET',
  'WRONG_SCOPE',
  'WRONG_BOUNDARY',
  'WRONG_CAPABILITY',
  'UNDERSHARE',
  'OVERSHARE',
  'CORRECT'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function canonicalTargets(targets) {
  return [...targets].sort((left, right) =>
    left.field_ref.localeCompare(right.field_ref) ||
    left.target_role.localeCompare(right.target_role) ||
    left.semantic_type.localeCompare(right.semantic_type));
}

function canonicalRequirement(requirement) {
  return {
    operation_ref: requirement.operation_ref,
    targets: canonicalTargets(requirement.targets),
    capability: {
      family: requirement.capability.family,
      name: requirement.capability.name,
      parameters: sortObject(requirement.capability.parameters)
    },
    scope: sortObject(requirement.scope),
    boundary: requirement.boundary,
    authority: {
      authority_class: requirement.authority_witness.authority_class,
      support_type: requirement.authority_witness.support_type,
      support_ref: requirement.authority_witness.support_ref
    }
  };
}

function canonicalRequirementKey(requirement) {
  return stableJson(canonicalRequirement(requirement));
}

function capabilitySemantic(name) {
  return catalog.capability_semantics.find((item) => item.name === name);
}

function operationMap(document) {
  return new Map(document.task_ir.operations.map((operation) => [operation.operation_id, operation]));
}

function contextSourceMap(seedCase) {
  return new Map(seedCase.trusted_context.sources.map((source) => [source.source_id, source]));
}

function trustedClaims(seedCase) {
  return new Set(seedCase.trusted_context.sources
    .filter((source) => TRUSTED_AUTHORITY.has(source.authority_class))
    .flatMap((source) => source.claims.map((claim) => claim.claim_id)));
}

function authorityWitnessValid(seedCase, requirement) {
  const witness = requirement.authority_witness;
  const source = contextSourceMap(seedCase).get(witness.source_id);
  if (!source) return false;
  if (!TRUSTED_AUTHORITY.has(source.authority_class)) return false;
  if (source.authority_class !== witness.authority_class) return false;
  return source.supports.some((support) =>
    support.support_type === witness.support_type && support.support_ref === witness.support_ref);
}

function semanticError(seedCase, requirement) {
  if (Object.hasOwn(requirement, 'exact_value_required')) return 'SEMANTIC_INVALID';
  const semantic = capabilitySemantic(requirement.capability.name);
  if (!semantic || semantic.family !== requirement.capability.family) return 'SEMANTIC_INVALID';
  if (requirement.targets.length < semantic.arity.minimum || requirement.targets.length > semantic.arity.maximum) {
    return 'SEMANTIC_INVALID';
  }
  if (!semantic.allowed_scopes.includes(requirement.scope.kind)) return 'SEMANTIC_INVALID';
  const parameterKeys = Object.keys(requirement.capability.parameters).sort();
  const requiredKeys = [...semantic.required_parameters].sort();
  if (!assertPartialArrayEqual(parameterKeys, requiredKeys)) return 'SEMANTIC_INVALID';
  for (const target of requirement.targets) {
    if (!semantic.target_roles.includes(target.target_role)) return 'SEMANTIC_INVALID';
    if (!semantic.applicable_field_types.includes(target.semantic_type)) return 'SEMANTIC_INVALID';
  }
  if (!authorityWitnessValid(seedCase, requirement)) return 'AUTHORITY_VIOLATION';
  return null;
}

function assertPartialArrayEqual(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function validatePlannerDocument(seedCase) {
  const document = seedCase.planner_document;
  assert.equal(document.schema_version, 'planner-capability-schema-v0.2');
  assert.equal(document.task_ir.task_ir_version, 'task-ir-v0.2');
  assert.equal(document.capability_requirements.capability_ir_version, 'information-capability-ir-v0.2');

  const operations = operationMap(document);
  assert.equal(operations.size, document.task_ir.operations.length, `${seedCase.task_id}: duplicate operation id`);
  for (const operation of document.task_ir.operations) {
    assert.notEqual(operation.depends_on.includes(operation.operation_id), true);
    for (const dependency of operation.depends_on) assert.ok(operations.has(dependency), dependency);
    if (operation.role === 'TOOL_EXECUTION') assert.equal(operation.family, 'tool_call');
    if (operation.family === 'tool_call') {
      assert.ok(operation.tool_ref);
      assert.ok(operation.tool_parameters.length > 0);
    }
  }

  const requirementIds = new Set();
  const canonical = new Set();
  for (const requirement of document.capability_requirements.requirements) {
    assert.equal(requirementIds.has(requirement.requirement_id), false, requirement.requirement_id);
    requirementIds.add(requirement.requirement_id);
    assert.equal(Object.hasOwn(requirement, 'purpose'), false);
    assert.equal(Object.hasOwn(requirement, 'exact_value_required'), false);
    const operation = operations.get(requirement.operation_ref);
    assert.ok(operation, `${seedCase.task_id}/${requirement.operation_ref}`);
    for (const target of requirement.targets) {
      assert.ok(operation.inputs.some((input) => stableJson(input) === stableJson(target)),
        `${seedCase.task_id}/${requirement.requirement_id}/${target.field_ref}`);
    }
    assert.equal(semanticError(seedCase, requirement), null, requirement.requirement_id);
    const key = canonicalRequirementKey(requirement);
    assert.equal(canonical.has(key), false, `${seedCase.task_id}: duplicate canonical requirement`);
    canonical.add(key);
  }
}

function invariantPrimary(contract) {
  if (contract.depends_on_task_answer || contract.selects_subset || contract.introduces_rank ||
      contract.introduces_aggregate || contract.introduces_derived_relation ||
      !contract.uniform_across_records) return 'ANSWER_LEAKAGE';
  if (!contract.field_local && !contract.preserves_existing_relation) return 'SEMANTIC_INVALID';
  return null;
}

function transformationContract(transformationId) {
  return catalog.transformation_contracts.find((item) => item.transformation_id === transformationId);
}

function coverageCapabilityMatches(coverage, requirement) {
  if (coverage.capability === requirement.capability.name) return true;
  const coverageSemantic = capabilitySemantic(coverage.capability);
  return Boolean(coverageSemantic?.entails.includes(requirement.capability.name));
}

function actionSatisfaction(seedCase, dimension, action, requirement) {
  const reasons = [];
  const contract = transformationContract(action.transformation_id);
  const invariantError = invariantPrimary(contract);
  if (invariantError) reasons.push('NO_SOLVER_INVARIANT_VIOLATION');

  const targetsCovered = requirement.targets.every((target) => dimension.target_fields.some((field) =>
    field.field_ref === target.field_ref && field.semantic_type === target.semantic_type));
  if (!targetsCovered) reasons.push('NO_DIMENSION_FOR_TARGET');

  const sameCapability = action.coverage.filter((coverage) => coverageCapabilityMatches(coverage, requirement));
  if (sameCapability.length === 0) reasons.push('NO_ACTION_PROVIDES_CAPABILITY');
  const sameParameters = sameCapability.filter((coverage) =>
    stableJson(coverage.parameters) === stableJson(requirement.capability.parameters));
  if (sameCapability.length > 0 && sameParameters.length === 0) reasons.push('CAPABILITY_PARAMETER_MISMATCH');
  const sameBoundary = sameParameters.filter((coverage) => coverage.boundary === requirement.boundary);
  if (sameParameters.length > 0 && sameBoundary.length === 0) reasons.push('BOUNDARY_MISMATCH');

  const claims = trustedClaims(seedCase);
  const proved = sameBoundary.filter((coverage) =>
    coverage.required_preconditions.every((precondition) => claims.has(precondition)));
  if (sameBoundary.length > 0 && proved.length === 0) reasons.push('UNPROVED_TRUSTED_PRECONDITION');

  return {ok: reasons.length === 0 && proved.length > 0, reasons: [...new Set(reasons)]};
}

function enumerateSelections(dimensions) {
  const selections = [];
  function visit(index, vector, actions) {
    if (index === dimensions.length) {
      selections.push({vector, actions});
      return;
    }
    for (const action of dimensions[index].candidate_actions) {
      visit(index + 1, [...vector, action.level], [...actions, {dimension: dimensions[index], action}]);
    }
  }
  visit(0, [], []);
  return selections;
}

function dominates(left, right) {
  return left.every((level, index) => level <= right[index]) &&
    left.some((level, index) => level < right[index]);
}

function compareVectors(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function canonicalPlanActions(actions) {
  return stableJson(actions.map(({dimension, action}) => ({
    dimension_ref: dimension.dimension_ref,
    canonical_action: action.canonical_action
  })));
}

function selectParetoReportingPlan(feasible) {
  const minimal = feasible.filter((candidate) =>
    !feasible.some((other) => dominates(other.vector, candidate.vector)));
  minimal.sort((left, right) => compareVectors(left.vector, right.vector) ||
    canonicalPlanActions(left.actions).localeCompare(canonicalPlanActions(right.actions)));
  return {minimal, selected: minimal[0]};
}

function compileSeed(seedCase, requirementOverride) {
  const requirements = requirementOverride ?? seedCase.planner_document.capability_requirements.requirements;
  for (const requirement of requirements) {
    const error = semanticError(seedCase, requirement);
    if (error) return {status: 'INFEASIBLE', reasons: ['SEMANTIC_REQUIREMENT_INVALID'], primary_error: error};
  }

  const dimensions = catalog.dimensions
    .filter((dimension) => dimension.task_id === seedCase.task_id)
    .sort((left, right) => left.order - right.order);
  const feasible = enumerateSelections(dimensions).filter((candidate) =>
    requirements.every((requirement) => candidate.actions.some(({dimension, action}) =>
      actionSatisfaction(seedCase, dimension, action, requirement).ok)));

  if (feasible.length === 0) return {status: 'INFEASIBLE', reasons: ['NO_ACTION_PROVIDES_CAPABILITY']};
  const {minimal, selected} = selectParetoReportingPlan(feasible);
  return {
    status: 'FEASIBLE',
    feasible_count: feasible.length,
    pareto_minimal_count: minimal.length,
    selected_vector: selected.vector,
    selected_plan: selected.actions.map(({dimension, action}) => ({
      dimension_ref: dimension.dimension_ref,
      transformation_id: action.transformation_id
    }))
  };
}

function diagnoseMismatch(gold, predicted) {
  if (predicted.operation_ref !== gold.operation_ref) return 'WRONG_OPERATION_BINDING';
  if (stableJson(canonicalTargets(predicted.targets)) !== stableJson(canonicalTargets(gold.targets))) return 'WRONG_TARGET';
  if (stableJson(predicted.scope) !== stableJson(gold.scope)) return 'WRONG_SCOPE';
  if (predicted.boundary !== gold.boundary) return 'WRONG_BOUNDARY';
  if (stableJson(predicted.capability) !== stableJson(gold.capability)) return 'WRONG_CAPABILITY';
  return 'CORRECT';
}

test('v0.2 JSON artifacts parse and Planner documents validate against the closed JSON Schema', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  const script = [
    `$schemaPath='${path.join(ROOT, 'fixtures', 'planner-capability-schema-v0.2.json').replaceAll("'", "''")}'`,
    `$seeds=Get-Content -LiteralPath '${path.join(ROOT, 'fixtures', 'planner-seed-cases-v0.2.json').replaceAll("'", "''")}' -Raw | ConvertFrom-Json -Depth 100`,
    'foreach($case in $seeds.cases){',
    '  $json=$case.planner_document | ConvertTo-Json -Depth 100 -Compress',
    '  if(-not ($json | Test-Json -SchemaFile $schemaPath)){ exit 2 }',
    '}'
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('all seven seeds have operation-bound canonical requirements and valid authority witnesses', () => {
  assert.equal(seeds.seed_role, 'development-and-ontology-coverage-only');
  assert.equal(seeds.generalization_claim_allowed, false);
  assert.deepEqual(seeds.cases.map((item) => item.task_id), [
    'MD-EQ-01', 'MD-GROUP-02', 'MD-ORDER-03', 'MD-LOC-04',
    'MD-CROSS-05', 'MD-GRAPH-06', 'MD-TOOL-07'
  ]);
  for (const seedCase of seeds.cases) validatePlannerDocument(seedCase);
});

test('capability semantics are complete, conservative, and qualification is explicit', () => {
  const names = schema.$defs.capability.properties.name.enum;
  assert.equal(catalog.capability_semantics.length, names.length);
  assert.deepEqual(new Set(catalog.capability_semantics.map((item) => item.name)), new Set(names));
  for (const semantic of catalog.capability_semantics) {
    assert.ok(['seed-qualified', 'unqualified-in-v0.2'].includes(semantic.qualification));
    assert.ok(semantic.arity.minimum > 0);
    assert.ok(semantic.arity.maximum >= semantic.arity.minimum);
    assert.ok(semantic.target_roles.length > 0);
    assert.ok(semantic.applicable_field_types.length > 0);
    assert.ok(Array.isArray(semantic.required_parameters));
    assert.ok(Array.isArray(semantic.satisfaction_conditions));
    assert.ok(Array.isArray(semantic.entails));
    assert.ok(Array.isArray(semantic.does_not_entail));
    assert.equal(semantic.entails.some((name) => semantic.does_not_entail.includes(name)), false);
  }
  for (const name of ['category', 'coarse_temporal', 'geographic_region', 'membership', 'directionality']) {
    assert.equal(capabilitySemantic(name).qualification, 'unqualified-in-v0.2');
  }
  assert.ok(capabilitySemantic('identity').does_not_entail.includes('equality'));
  assert.ok(capabilitySemantic('existing_relation').does_not_entail.includes('directionality'));
  assert.ok(capabilitySemantic('ordering').does_not_entail.includes('temporal_comparison'));
});

test('the catalog exactly reuses frozen md-bench action chains and is canonically ordered', () => {
  const orderedDimensions = [...catalog.dimensions].sort((left, right) => left.order - right.order);
  assert.deepEqual(orderedDimensions.map((item) => item.dimension_ref), catalog.canonical_dimension_order);
  assert.equal(new Set(catalog.canonical_dimension_order).size, catalog.canonical_dimension_order.length);
  assert.equal(catalog.finite_space, true);
  assert.equal(catalog.boundary_policy.raw_fallback, false);

  for (const oldTask of oldSearchSpace.tasks) {
    for (const oldDimension of oldTask.dimensions) {
      const dimension = catalog.dimensions.find((item) =>
        item.task_id === oldTask.task_id && item.dimension_id === oldDimension.dimension_id);
      assert.ok(dimension, `${oldTask.task_id}/${oldDimension.dimension_id}`);
      assert.deepEqual(dimension.candidate_actions.map((item) => item.transformation_id),
        oldDimension.chain.map((item) => item.transform_id));
      oldDimension.chain.forEach((oldAction, index) => {
        const canonical = dimension.candidate_actions[index].canonical_action;
        assert.equal(canonical.transform_id, oldAction.transform_id);
        assert.equal(canonical.representation, oldAction.representation);
        assert.equal(canonical.property_name, oldAction.property_name);
        assert.equal(canonical.reversible, oldAction.reversible);
      });
    }
  }
  const relationDimension = catalog.dimensions.find((item) => item.dimension_ref === 'MD-GRAPH-06/source_relations');
  assert.deepEqual(relationDimension.candidate_actions.map((item) => item.transformation_id), ['RELATION_ONLY']);
});

test('all catalog transformations satisfy No-Solver invariants', () => {
  const ids = new Set();
  for (const contract of catalog.transformation_contracts) {
    assert.equal(ids.has(contract.transformation_id), false);
    ids.add(contract.transformation_id);
    assert.equal(invariantPrimary(contract), null, contract.transformation_id);
    assert.ok(contract.source_provenance.startsWith('md-bench-v0.2/'));
  }
  for (const dimension of catalog.dimensions) {
    assert.ok(dimension.candidate_actions.length > 0);
    dimension.candidate_actions.forEach((action, index) => {
      assert.equal(action.level, index);
      assert.ok(ids.has(action.transformation_id));
      assert.equal(action.canonical_action.transform_id, action.transformation_id);
    });
  }
});

test('representation coverage uses parameters and proved preconditions rather than fixture coincidence', () => {
  const order = seeds.cases.find((item) => item.task_id === 'MD-ORDER-03');
  const orderRequirement = order.planner_document.capability_requirements.requirements[0];
  const orderDimension = catalog.dimensions.find((item) => item.dimension_ref === 'MD-ORDER-03/date_of_birth');
  const birthYear = orderDimension.candidate_actions.find((item) => item.transformation_id === 'BIRTH_YEAR');
  assert.equal(actionSatisfaction(order, orderDimension, birthYear, orderRequirement).ok, true);
  const withoutProof = clone(order);
  withoutProof.trusted_context.sources.forEach((source) => {
    source.claims = source.claims.filter((claim) => claim.claim_id !== 'DOB_YEAR_ORDER_PRESERVING');
  });
  const failed = actionSatisfaction(withoutProof, orderDimension, birthYear, orderRequirement);
  assert.equal(failed.ok, false);
  assert.ok(failed.reasons.includes('UNPROVED_TRUSTED_PRECONDITION'));

  const cross = seeds.cases.find((item) => item.task_id === 'MD-CROSS-05');
  const temporal = cross.planner_document.capability_requirements.requirements
    .find((item) => item.requirement_id === 'req.cross.temporal');
  const timestampDimension = catalog.dimensions.find((item) => item.dimension_ref === 'MD-CROSS-05/timestamp');
  const hour = timestampDimension.candidate_actions.find((item) => item.transformation_id === 'HOUR_BUCKET');
  assert.equal(actionSatisfaction(cross, timestampDimension, hour, temporal).ok, true);
  const wrongThreshold = clone(temporal);
  wrongThreshold.capability.parameters.threshold.value = 48;
  const mismatch = actionSatisfaction(cross, timestampDimension, hour, wrongThreshold);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.reasons.includes('CAPABILITY_PARAMETER_MISMATCH'));
});

test('deterministic compiler feasibility explains all seven expected Oracle representations', () => {
  for (const seedCase of seeds.cases) {
    const compiled = compileSeed(seedCase);
    assert.equal(compiled.status, 'FEASIBLE', seedCase.task_id);
    assert.deepEqual(compiled.selected_plan, seedCase.oracle_bridge.expected_reporting_plan, seedCase.task_id);
  }
});

test('compiler returns INFEASIBLE for an uncovered valid capability and never injects RAW fallback', () => {
  const loc = clone(seeds.cases.find((item) => item.task_id === 'MD-LOC-04'));
  const requirement = clone(loc.planner_document.capability_requirements.requirements[0]);
  requirement.capability = {
    family: 'property',
    name: 'geographic_region',
    parameters: {region_scheme_ref: 'workflow.zone_rule'}
  };
  assert.equal(semanticError(loc, requirement), null);
  const compiled = compileSeed(loc, [requirement]);
  assert.equal(compiled.status, 'INFEASIBLE');
  assert.ok(compiled.reasons.includes('NO_ACTION_PROVIDES_CAPABILITY'));
});

test('Pareto selection and both deterministic tie-break stages are stable', () => {
  const dimensionA = {dimension_ref: 'test/a'};
  const dimensionB = {dimension_ref: 'test/b'};
  const candidates = [
    {vector: [1, 0], actions: [{dimension: dimensionA, action: {canonical_action: {id: 'a1'}}}, {dimension: dimensionB, action: {canonical_action: {id: 'b0'}}}]},
    {vector: [0, 1], actions: [{dimension: dimensionA, action: {canonical_action: {id: 'a0'}}}, {dimension: dimensionB, action: {canonical_action: {id: 'b1'}}}]},
    {vector: [1, 1], actions: [{dimension: dimensionA, action: {canonical_action: {id: 'a1'}}}, {dimension: dimensionB, action: {canonical_action: {id: 'b1'}}}]}
  ];
  const selected = selectParetoReportingPlan(candidates);
  assert.equal(selected.minimal.length, 2);
  assert.deepEqual(selected.selected.vector, [0, 1]);

  const sameVector = [
    {vector: [0], actions: [{dimension: dimensionA, action: {canonical_action: {id: 'z'}}}]},
    {vector: [0], actions: [{dimension: dimensionA, action: {canonical_action: {id: 'a'}}}]}
  ];
  assert.equal(selectParetoReportingPlan(sameVector).selected.actions[0].action.canonical_action.id, 'a');
});

test('exact_value has one authoritative representation and legacy flags are invalid', () => {
  const tool = seeds.cases.find((item) => item.task_id === 'MD-TOOL-07');
  const recipient = tool.planner_document.capability_requirements.requirements
    .find((item) => item.requirement_id === 'req.tool.recipient');
  assert.equal(recipient.capability.name, 'exact_value');
  assert.deepEqual(recipient.capability.parameters, {});
  assert.equal(Object.hasOwn(recipient, 'exact_value_required'), false);
  const conflict = clone(recipient);
  conflict.exact_value_required = false;
  assert.equal(semanticError(tool, conflict), 'SEMANTIC_INVALID');
});

test('canonicalization includes operation, roles, parameters, scope, boundary, and witness class', () => {
  const requirements = seeds.cases.flatMap((seedCase) =>
    seedCase.planner_document.capability_requirements.requirements);
  for (const requirement of requirements) {
    const canonical = canonicalRequirement(requirement);
    assert.ok(canonical.operation_ref);
    assert.ok(canonical.targets.every((target) => target.target_role));
    assert.ok(canonical.capability.parameters);
    assert.ok(canonical.scope.kind);
    assert.ok(canonical.boundary);
    assert.ok(canonical.authority.authority_class);
    assert.ok(canonical.authority.support_type);
    assert.ok(canonical.authority.support_ref);
    assert.equal(Object.hasOwn(canonical, 'requirement_id'), false);
  }
  const sample = requirements[0];
  const duplicate = clone(sample);
  duplicate.requirement_id = 'req.duplicate';
  assert.equal(canonicalRequirementKey(sample), canonicalRequirementKey(duplicate));
});

test('semantic negative fixtures cover authority, solver leakage, evaluator mismatch, precondition, and exact consistency', () => {
  assert.equal(negatives.cases.length, 12);
  for (const negative of negatives.cases) {
    const mutation = negative.mutation;
    if (mutation.type === 'TRANSFORMATION_INVARIANT_OVERRIDE') {
      const contract = clone(transformationContract(mutation.base_transformation_id));
      Object.assign(contract, mutation.overrides);
      assert.equal(invariantPrimary(contract), negative.expected_primary_error, negative.case_id);
      continue;
    }

    const seedCase = clone(seeds.cases.find((item) => item.task_id === negative.base_task_id));
    const requirements = seedCase.planner_document.capability_requirements.requirements;
    const requirement = mutation.requirement_id
      ? requirements.find((item) => item.requirement_id === mutation.requirement_id)
      : null;

    if (mutation.type === 'SET_AUTHORITY_WITNESS') {
      seedCase.trusted_context.sources.push(mutation.add_context_source);
      requirement.authority_witness = mutation.witness;
      assert.equal(semanticError(seedCase, requirement), negative.expected_primary_error, negative.case_id);
    } else if (mutation.type === 'SET_REQUIREMENT_TARGET') {
      const gold = clone(requirement);
      requirement.targets = [mutation.target];
      assert.equal(diagnoseMismatch(gold, requirement), negative.expected_primary_error, negative.case_id);
    } else if (mutation.type === 'SET_REQUIREMENT_BOUNDARY') {
      const gold = clone(requirement);
      requirement.boundary = mutation.boundary;
      assert.equal(diagnoseMismatch(gold, requirement), negative.expected_primary_error, negative.case_id);
    } else if (mutation.type === 'SET_REQUIREMENT_SCOPE') {
      const gold = clone(requirement);
      requirement.scope = mutation.scope;
      assert.equal(diagnoseMismatch(gold, requirement), negative.expected_primary_error, negative.case_id);
    } else if (mutation.type === 'SET_OPERATION_REF') {
      const gold = clone(requirement);
      requirement.operation_ref = mutation.operation_ref;
      assert.equal(diagnoseMismatch(gold, requirement), negative.expected_primary_error, negative.case_id);
    } else if (mutation.type === 'REMOVE_TRUSTED_CLAIM') {
      seedCase.trusted_context.sources.forEach((source) => {
        source.claims = source.claims.filter((claim) => claim.claim_id !== mutation.claim_id);
      });
      const dimension = catalog.dimensions.find((item) => item.task_id === seedCase.task_id);
      const action = dimension.candidate_actions.find((item) => item.transformation_id === mutation.transformation_id);
      const result = actionSatisfaction(seedCase, dimension, action, requirements[0]);
      assert.equal(result.ok, false, negative.case_id);
      assert.ok(result.reasons.includes(negative.expected_reason), negative.case_id);
    } else if (mutation.type === 'ADD_LEGACY_EXACT_FLAG') {
      requirement.exact_value_required = mutation.exact_value_required;
      assert.equal(semanticError(seedCase, requirement), negative.expected_primary_error, negative.case_id);
    } else {
      assert.fail(`unsupported negative mutation: ${mutation.type}`);
    }
  }
});

test('error precedence is frozen and primary diagnostics are not double counted', () => {
  assert.deepEqual(ERROR_PRECEDENCE, [
    'ANSWER_LEAKAGE', 'AUTHORITY_VIOLATION', 'SEMANTIC_INVALID',
    'WRONG_OPERATION_BINDING', 'WRONG_TARGET', 'WRONG_SCOPE',
    'WRONG_BOUNDARY', 'WRONG_CAPABILITY', 'UNDERSHARE', 'OVERSHARE', 'CORRECT'
  ]);
  const observed = ['WRONG_SCOPE', 'AUTHORITY_VIOLATION', 'WRONG_BOUNDARY'];
  const primary = [...observed].sort((left, right) =>
    ERROR_PRECEDENCE.indexOf(left) - ERROR_PRECEDENCE.indexOf(right))[0];
  assert.equal(primary, 'AUTHORITY_VIOLATION');
});

test('presentation remains independent of privacy capabilities and LOC remains qualified only as an expression seed', () => {
  const capabilityText = seeds.cases.map((item) =>
    JSON.stringify(item.planner_document.capability_requirements)).join('\n');
  for (const forbidden of [
    'SOURCE_APPEARANCE_ORDER', 'ENDPOINT_APPEARANCE_ORDER', 'WORKFLOW_DECLARED_ORDER',
    'IGNORE_JSON_KEY_ORDER', 'g1', 'g2', 'n1', 'n2', 'n3'
  ]) assert.equal(capabilityText.includes(forbidden), false, forbidden);
  const loc = seeds.cases.find((item) => item.task_id === 'MD-LOC-04');
  assert.equal(loc.oracle_bridge.utility_validation_status,
    'renderer-order-confounded-for-previous-utility-experiment');
  assert.ok(loc.planner_document.task_ir.presentation.some((item) => item.rule === 'IGNORE_JSON_KEY_ORDER'));
});

test('seed fixture is raw-blind and contains no task answer or solved relation', () => {
  const seedText = JSON.stringify(seeds);
  for (const task of frozen.tasks) {
    for (const entity of task.sensitive_entities) {
      assert.equal(seedText.includes(entity.raw_value), false, entity.occurrence_id);
    }
  }
  for (const forbidden of [
    'ground_truth', 'selected_entity', 'selected_candidate', 'aggregate_result',
    'matched_pair', 'degree_result', 'reachability_result', 'final_recipient', 'restored_output'
  ]) assert.equal(seedText.includes(`"${forbidden}"`), false, forbidden);
});

test('v0.2 literature boundary contains no priority claim wording', () => {
  const text = [
    fs.readFileSync(path.join(ROOT, 'docs', 'planner-spec-v0.2.md'), 'utf8'),
    JSON.stringify(catalog), JSON.stringify(seeds), JSON.stringify(negatives)
  ].join('\n');
  assert.equal(/\bfirst\b/i.test(text), false);
  assert.equal(/\bnovel\b/i.test(text), false);
  assert.equal(text.includes('首次'), false);
  assert.equal(text.includes('无人研究'), false);
});

test('the frozen v0.1 annotated tag, commit, and tree remain intact', () => {
  const git = (...args) => execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
  assert.equal(git('rev-parse', 'planner-spec-v0.1^{tag}'), '046bc80778793b1372c85c3493fded1698c8580e');
  assert.equal(git('rev-parse', 'planner-spec-v0.1^{commit}'), '633882f7bfcbe9416822ac6e92e89af6902c1524');
  assert.equal(git('rev-parse', 'planner-spec-v0.1^{tree}'), '1558bd87fb489356ca794af3384f7576eeeb2b2f');
});
