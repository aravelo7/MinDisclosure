'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

const schema = loadJson('fixtures/planner-capability-schema-v0.2.1.json');
const seeds = loadJson('fixtures/planner-seed-cases-v0.2.1.json');
const catalog = loadJson('fixtures/planner-representation-catalog-v0.2.1.json');
const negatives = loadJson('fixtures/planner-negative-cases-v0.2.1.json');
const priorCatalog = loadJson('fixtures/planner-representation-catalog-v0.2.json');

const TRUSTED_AUTHORITY = new Set([
  'USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObject(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function exactKeys(value, keys) {
  return stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function noExtraKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function operationMap(document) {
  return new Map(document.task_ir.operations.map((operation) => [
    operation.operation_id, operation
  ]));
}

function sourceMap(trustedContext) {
  return new Map(trustedContext.sources.map((source) => [
    source.source_id, source
  ]));
}

function exactOperationInput(operation, target) {
  return operation.inputs.some((input) => stableJson(input) === stableJson(target));
}

function collectStructuredReferences(value, references = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredReferences(item, references));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStructuredReferences(item, references));
  } else if (typeof value === 'string') {
    references.add(value);
  }
  return references;
}

function authorityWitnessValid(trustedContext, document, requirement) {
  const witness = requirement.authority_witness;
  const source = sourceMap(trustedContext).get(witness.source_id);
  if (!source) return false;
  if (!TRUSTED_AUTHORITY.has(source.authority_class)) return false;
  if (source.authority_class !== witness.authority_class) return false;
  if (!source.supports.some((support) =>
    support.support_type === witness.support_type &&
    support.support_ref === witness.support_ref)) return false;

  const operation = operationMap(document).get(requirement.operation_ref);
  if (!operation) return false;
  if (!requirement.targets.every((target) => exactOperationInput(operation, target))) return false;

  if (witness.support_type === 'OPERATION') {
    return witness.authority_class === 'USER_INTENT' &&
      witness.support_ref === requirement.operation_ref &&
      requirement.boundary === 'AGENT';
  }

  if (witness.support_type === 'SCHEMA_FIELD') {
    return witness.authority_class === 'DATA_SCHEMA' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' &&
      requirement.targets.some((target) => target.field_ref === witness.support_ref);
  }

  if (witness.support_type === 'WORKFLOW_RULE') {
    const references = collectStructuredReferences({
      capability: requirement.capability.parameters,
      operation: operation.parameters
    });
    return witness.authority_class === 'TRUSTED_WORKFLOW' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' &&
      references.has(witness.support_ref);
  }

  if (witness.support_type === 'SOURCE_RELATION') {
    const relationRoles = new Set(['RELATION_SOURCE', 'RELATION_TARGET']);
    return witness.authority_class === 'DATA_SCHEMA' &&
      requirement.boundary === 'AGENT' &&
      requirement.scope.kind === 'DECLARED_RELATION_SET' &&
      requirement.scope.reference === witness.support_ref &&
      ['existing_relation', 'directionality'].includes(requirement.capability.name) &&
      requirement.targets.every((target) => relationRoles.has(target.target_role));
  }

  if (witness.support_type === 'TOOL_PARAMETER') {
    if (witness.authority_class !== 'TOOL_SCHEMA' ||
        operation.family !== 'tool_call' ||
        operation.role !== 'TOOL_EXECUTION' ||
        requirement.boundary !== 'TOOL' ||
        requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' ||
        requirement.scope.reference !== witness.support_ref ||
        requirement.targets.length !== 1 ||
        requirement.targets[0].target_role !== 'TOOL_ARGUMENT') return false;
    const target = requirement.targets[0];
    return operation.tool_parameters.some((parameter) =>
      parameter.parameter_ref === witness.support_ref &&
      parameter.source_field_ref === target.field_ref);
  }

  return false;
}

function capabilitySemantic(name) {
  return catalog.capability_semantics.find((item) => item.name === name);
}

function semanticError(trustedContext, document, requirement) {
  if (Object.hasOwn(requirement, 'exact_value_required')) return 'SEMANTIC_INVALID';
  const operation = operationMap(document).get(requirement.operation_ref);
  if (!operation) return 'SEMANTIC_INVALID';
  if (!requirement.targets.every((target) => exactOperationInput(operation, target))) {
    return 'SEMANTIC_INVALID';
  }

  const semantic = capabilitySemantic(requirement.capability.name);
  if (!semantic || semantic.family !== requirement.capability.family) {
    return 'SEMANTIC_INVALID';
  }
  if (requirement.targets.length < semantic.arity.minimum ||
      requirement.targets.length > semantic.arity.maximum) {
    return 'SEMANTIC_INVALID';
  }
  if (!semantic.allowed_scopes.includes(requirement.scope.kind)) {
    return 'SEMANTIC_INVALID';
  }
  if (stableJson(Object.keys(requirement.capability.parameters).sort()) !==
      stableJson([...semantic.required_parameters].sort())) {
    return 'SEMANTIC_INVALID';
  }
  for (const target of requirement.targets) {
    if (!semantic.target_roles.includes(target.target_role) ||
        !semantic.applicable_field_types.includes(target.semantic_type)) {
      return 'SEMANTIC_INVALID';
    }
  }
  if (!authorityWitnessValid(trustedContext, document, requirement)) {
    return 'AUTHORITY_VIOLATION';
  }
  return null;
}

const INVARIANT_KEYS = [
  'field_local', 'occurrence_local', 'uniform_across_records',
  'preserves_existing_relation', 'depends_on_task_answer', 'selects_subset',
  'introduces_rank', 'introduces_aggregate', 'introduces_derived_relation'
];

function transformationStructuralError(contract, policy = catalog.structural_validation) {
  if (!exactKeys(contract, policy.allowed_transformation_contract_fields)) {
    return 'ANSWER_LEAKAGE';
  }
  if (contract.metadata_policy !== 'NO_RUNTIME_METADATA') {
    return 'ANSWER_LEAKAGE';
  }
  if (contract.depends_on_task_answer || contract.selects_subset ||
      contract.introduces_rank || contract.introduces_aggregate ||
      contract.introduces_derived_relation || !contract.uniform_across_records) {
    return 'ANSWER_LEAKAGE';
  }

  const rule = policy.source_output_rules.find((candidate) =>
    candidate.source_fields === contract.source_fields &&
    candidate.output_fields === contract.output_fields &&
    candidate.source_binding === contract.source_binding &&
    candidate.output_binding === contract.output_binding &&
    candidate.derivation_kind === contract.derivation_kind &&
    candidate.occurrence_policy === contract.occurrence_policy &&
    candidate.metadata_policy === contract.metadata_policy &&
    candidate.relation_provenance === contract.relation_provenance &&
    candidate.source_provenance === contract.source_provenance &&
    INVARIANT_KEYS.every((key) =>
      candidate.required_invariants[key] === contract[key]));
  if (!rule) return 'ANSWER_LEAKAGE';

  if (contract.output_binding === 'SAME_SOURCE_OCCURRENCES' &&
      contract.source_binding !== 'DIMENSION_TARGET_FIELDS') {
    return 'ANSWER_LEAKAGE';
  }
  if (contract.output_binding === 'SOURCE_RELATION_SAME_EDGES' &&
      (contract.source_binding !== 'DECLARED_RELATION_ENDPOINTS' ||
       contract.relation_provenance !== 'SOURCE_DECLARED_ONLY')) {
    return 'ANSWER_LEAKAGE';
  }
  return null;
}

function catalogStructuralError(candidateCatalog) {
  const policy = catalog.structural_validation;
  if (!exactKeys(candidateCatalog, policy.allowed_top_level_fields)) {
    return 'CATALOG_STRUCTURE_INVALID';
  }

  const contracts = new Map();
  for (const contract of candidateCatalog.transformation_contracts) {
    if (contracts.has(contract.transformation_id)) return 'CATALOG_STRUCTURE_INVALID';
    if (transformationStructuralError(contract, policy)) return 'ANSWER_LEAKAGE';
    contracts.set(contract.transformation_id, contract);
  }

  for (const dimension of candidateCatalog.dimensions) {
    if (!exactKeys(dimension, policy.allowed_dimension_fields)) {
      return 'CATALOG_STRUCTURE_INVALID';
    }
    if (!dimension.operation_bindings.every((binding) =>
      exactKeys(binding, policy.allowed_operation_binding_fields))) {
      return 'CATALOG_STRUCTURE_INVALID';
    }
    for (const action of dimension.candidate_actions) {
      if (!exactKeys(action, policy.allowed_candidate_action_fields)) {
        return 'CATALOG_STRUCTURE_INVALID';
      }
      if (!noExtraKeys(action.canonical_action, policy.allowed_canonical_action_fields)) {
        return 'ANSWER_LEAKAGE';
      }
      if (!action.coverage.every((coverage) =>
        exactKeys(coverage, policy.allowed_coverage_fields))) {
        return 'CATALOG_STRUCTURE_INVALID';
      }
      const contract = contracts.get(action.transformation_id);
      if (!contract) return 'CATALOG_STRUCTURE_INVALID';
      if (!contract.canonical_action_templates.some((template) =>
        stableJson(template) === stableJson(action.canonical_action))) {
        return 'ANSWER_LEAKAGE';
      }
    }
  }
  return null;
}

function validateTrustedSlice(slice) {
  if (!slice || !exactKeys(slice, ['slice_id', 'catalog_version', 'dimension_refs'])) {
    return {ok:false, reason:'NO_TRUSTED_CATALOG_SLICE'};
  }
  if (slice.catalog_version !== catalog.catalog_version ||
      slice.dimension_refs.length === 0 ||
      new Set(slice.dimension_refs).size !== slice.dimension_refs.length) {
    return {ok:false, reason:'NO_TRUSTED_CATALOG_SLICE'};
  }
  const dimensions = new Map(catalog.dimensions.map((dimension) => [
    dimension.dimension_ref, dimension
  ]));
  if (!slice.dimension_refs.every((ref) => dimensions.has(ref))) {
    return {ok:false, reason:'NO_TRUSTED_CATALOG_SLICE'};
  }
  return {
    ok:true,
    dimensions:slice.dimension_refs.map((ref) => dimensions.get(ref))
      .sort((left, right) =>
        catalog.canonical_dimension_order.indexOf(left.dimension_ref) -
        catalog.canonical_dimension_order.indexOf(right.dimension_ref))
  };
}

function coverageCapabilityMatches(coverage, requirement) {
  if (coverage.capability === requirement.capability.name) return true;
  const semantic = capabilitySemantic(coverage.capability);
  return Boolean(semantic?.entails.includes(requirement.capability.name));
}

function dimensionMatchesRequirement(dimension, operation, requirement) {
  const targetsCovered = requirement.targets.every((target) =>
    dimension.target_fields.some((field) =>
      field.field_ref === target.field_ref &&
      field.semantic_type === target.semantic_type));
  if (!targetsCovered) return false;
  if (!requirement.targets.every((target) => exactOperationInput(operation, target))) {
    return false;
  }
  if (!dimension.operation_bindings.some((binding) =>
    binding.operation_families.includes(operation.family) &&
    binding.operation_roles.includes(operation.role))) {
    return false;
  }
  return dimension.candidate_actions.some((action) =>
    action.coverage.some((coverage) =>
      coverageCapabilityMatches(coverage, requirement) &&
      stableJson(coverage.parameters) === stableJson(requirement.capability.parameters) &&
      coverage.boundary === requirement.boundary));
}

function mapRequirementsToDimensions(document, trustedSlice) {
  const sliceResult = validateTrustedSlice(trustedSlice);
  if (!sliceResult.ok) return sliceResult;
  const operations = operationMap(document);
  const mapping = new Map();

  for (const requirement of document.capability_requirements.requirements) {
    const operation = operations.get(requirement.operation_ref);
    const matches = sliceResult.dimensions.filter((dimension) =>
      dimensionMatchesRequirement(dimension, operation, requirement));
    if (matches.length === 0) {
      const fullMatches = catalog.dimensions.filter((dimension) =>
        dimensionMatchesRequirement(dimension, operation, requirement));
      return {
        ok:false,
        reason:fullMatches.length > 0 ?
          'MISSING_REQUIRED_DIMENSION' : 'NO_ACTION_PROVIDES_CAPABILITY'
      };
    }
    if (matches.length > 1) {
      return {ok:false, reason:'AMBIGUOUS_DIMENSION_MAPPING'};
    }
    mapping.set(requirement.requirement_id, matches[0].dimension_ref);
  }
  return {ok:true, dimensions:sliceResult.dimensions, mapping};
}

function trustedClaims(trustedContext) {
  return new Set(trustedContext.sources
    .filter((source) => TRUSTED_AUTHORITY.has(source.authority_class))
    .flatMap((source) => source.claims.map((claim) => claim.claim_id)));
}

function actionSatisfies(trustedContext, action, requirement) {
  const matching = action.coverage.filter((coverage) =>
    coverageCapabilityMatches(coverage, requirement) &&
    stableJson(coverage.parameters) === stableJson(requirement.capability.parameters) &&
    coverage.boundary === requirement.boundary);
  if (matching.length === 0) return false;
  const claims = trustedClaims(trustedContext);
  return matching.some((coverage) =>
    coverage.required_preconditions.every((claim) => claims.has(claim)));
}

function enumerateSelections(dimensions) {
  const selections = [];
  function visit(index, vector, actions) {
    if (index === dimensions.length) {
      selections.push({vector, actions});
      return;
    }
    for (const action of dimensions[index].candidate_actions) {
      visit(index + 1, [...vector, action.level], [
        ...actions, {dimension:dimensions[index], action}
      ]);
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

function compileDocument(plannerDocument, trustedContext, trustedCatalogSlice) {
  const catalogError = catalogStructuralError(catalog);
  if (catalogError) {
    return {status:'INFEASIBLE', reasons:['CATALOG_STRUCTURE_INVALID'],
      primary_error:catalogError};
  }

  for (const requirement of plannerDocument.capability_requirements.requirements) {
    const error = semanticError(trustedContext, plannerDocument, requirement);
    if (error) {
      return {status:'INFEASIBLE', reasons:['SEMANTIC_REQUIREMENT_INVALID'],
        primary_error:error};
    }
  }

  const resolved = mapRequirementsToDimensions(plannerDocument, trustedCatalogSlice);
  if (!resolved.ok) return {status:'INFEASIBLE', reasons:[resolved.reason]};

  const requirements = plannerDocument.capability_requirements.requirements;
  const feasible = enumerateSelections(resolved.dimensions).filter((candidate) =>
    requirements.every((requirement) => {
      const dimensionRef = resolved.mapping.get(requirement.requirement_id);
      const selected = candidate.actions.find(({dimension}) =>
        dimension.dimension_ref === dimensionRef);
      return selected && actionSatisfies(
        trustedContext, selected.action, requirement);
    }));

  if (feasible.length === 0) {
    return {status:'INFEASIBLE', reasons:['NO_ACTION_PROVIDES_CAPABILITY']};
  }

  const minimal = feasible.filter((candidate) =>
    !feasible.some((other) => dominates(other.vector, candidate.vector)));
  minimal.sort((left, right) =>
    compareVectors(left.vector, right.vector) ||
    canonicalPlanActions(left.actions).localeCompare(canonicalPlanActions(right.actions)));
  const selected = minimal[0];
  return {
    status:'FEASIBLE',
    relevant_dimensions:resolved.dimensions.map((dimension) => dimension.dimension_ref),
    feasible_count:feasible.length,
    pareto_minimal_count:minimal.length,
    selected_vector:selected.vector,
    selected_plan:selected.actions.map(({dimension, action}) => ({
      dimension_ref:dimension.dimension_ref,
      transformation_id:action.transformation_id
    }))
  };
}

function caseByTask(taskId) {
  return clone(seeds.cases.find((item) => item.task_id === taskId));
}

test('v0.2.1 Planner documents and trusted slices validate against the closed schema', () => {
  assert.equal(schema.properties.schema_version.const,
    'planner-capability-schema-v0.2.1');
  assert.equal(schema.$defs.trusted_catalog_slice.additionalProperties, false);
  const schemaPath = path.join(ROOT,
    'fixtures', 'planner-capability-schema-v0.2.1.json').replaceAll("'", "''");
  const seedsPath = path.join(ROOT,
    'fixtures', 'planner-seed-cases-v0.2.1.json').replaceAll("'", "''");
  const script = [
    "$schemaPath='" + schemaPath + "'",
    "$seeds=Get-Content -LiteralPath '" + seedsPath +
      "' -Raw | ConvertFrom-Json -Depth 100",
    'foreach($case in $seeds.cases){',
    '  $json=$case.planner_document | ConvertTo-Json -Depth 100 -Compress',
    '  if(-not ($json | Test-Json -SchemaFile $schemaPath)){ exit 2 }',
    '}'
  ].join('; ');
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', script],
    {cwd:ROOT, encoding:'utf8'});
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);

  for (const seedCase of seeds.cases) {
    assert.equal(validateTrustedSlice(seedCase.trusted_catalog_slice).ok, true);
  }
});
test('authority support compatibility accepts every valid v0.2.1 witness', () => {
  for (const seedCase of seeds.cases) {
    for (const requirement of seedCase.planner_document.capability_requirements.requirements) {
      assert.equal(
        semanticError(seedCase.trusted_context, seedCase.planner_document, requirement),
        null,
        requirement.requirement_id
      );
    }
  }
});

test('trusted but unrelated operation, target, and Tool scope witnesses fail closed', () => {
  for (const caseId of [
    'NEG-AUTH-TRUSTED-WRONG-OPERATION',
    'NEG-AUTH-TRUSTED-WRONG-TARGET',
    'NEG-AUTH-TRUSTED-WRONG-TOOL-SCOPE'
  ]) {
    const negative = negatives.cases.find((item) => item.case_id === caseId);
    const seedCase = caseByTask(negative.base_task_id);
    const requirement = seedCase.planner_document.capability_requirements.requirements
      .find((item) => item.requirement_id === negative.mutation.requirement_id);
    if (negative.mutation.type === 'SET_AUTHORITY_WITNESS') {
      requirement.authority_witness = negative.mutation.witness;
    } else if (negative.mutation.type === 'SET_REQUIREMENT_TARGET') {
      requirement.targets = [negative.mutation.target];
    } else {
      requirement.scope = negative.mutation.scope;
    }
    assert.equal(
      semanticError(seedCase.trusted_context, seedCase.planner_document, requirement),
      negative.expected_primary_error,
      caseId
    );
  }
});

test('untrusted content cannot expand authority and forged labels still fail', () => {
  for (const caseId of [
    'NEG-AUTH-UNTRUSTED-EXPANSION',
    'NEG-AUTH-FORGED-USER-WITNESS'
  ]) {
    const negative = negatives.cases.find((item) => item.case_id === caseId);
    const seedCase = caseByTask(negative.base_task_id);
    const requirement = seedCase.planner_document.capability_requirements.requirements
      .find((item) => item.requirement_id === negative.mutation.requirement_id);
    seedCase.trusted_context.sources.push(negative.mutation.add_context_source);
    requirement.authority_witness = negative.mutation.witness;
    assert.equal(
      semanticError(seedCase.trusted_context, seedCase.planner_document, requirement),
      'AUTHORITY_VIOLATION'
    );
  }
});

test('closed catalog structure accepts all valid transformations and actions', () => {
  assert.equal(catalogStructuralError(catalog), null);
  for (const contract of catalog.transformation_contracts) {
    assert.equal(transformationStructuralError(contract), null,
      contract.transformation_id);
  }
});

test('arbitrary metadata, fake-safe output, provenance mismatch, and occurrence bypass reject', () => {
  for (const caseId of [
    'NEG-SOLVER-ARBITRARY-ANSWER-METADATA',
    'NEG-SOLVER-FAKE-SAFE-UNSAFE-OUTPUT',
    'NEG-SOLVER-SOURCE-OUTPUT-PROVENANCE-MISMATCH',
    'NEG-SOLVER-OCCURRENCE-SPECIFIC-STRUCTURAL-BYPASS'
  ]) {
    const negative = negatives.cases.find((item) => item.case_id === caseId);
    const contract = clone(catalog.transformation_contracts.find((item) =>
      item.transformation_id === negative.mutation.base_transformation_id));
    if (negative.mutation.type === 'ADD_TRANSFORMATION_FIELD') {
      contract[negative.mutation.field] = negative.mutation.value;
    } else {
      Object.assign(contract, negative.mutation.fields);
    }
    assert.equal(
      transformationStructuralError(contract),
      negative.expected_primary_error,
      caseId
    );
  }
});

test('catalog action chains, capability ontology, and boundaries are unchanged from v0.2', () => {
  assert.deepEqual(
    catalog.capability_semantics.map((item) => item.name),
    priorCatalog.capability_semantics.map((item) => item.name)
  );
  assert.deepEqual(catalog.boundary_policy.boundaries, ['AGENT', 'TOOL']);
  for (const priorDimension of priorCatalog.dimensions) {
    const dimension = catalog.dimensions.find((item) =>
      item.dimension_ref === priorDimension.dimension_ref);
    assert.ok(dimension);
    assert.deepEqual(
      dimension.candidate_actions.map((item) => ({
        level:item.level,
        transformation_id:item.transformation_id,
        canonical_action:item.canonical_action,
        coverage:item.coverage
      })),
      priorDimension.candidate_actions
    );
  }
});

const EXPECTED_PLANS = {
  'slice.md-eq-01': [
    {dimension_ref:'MD-EQ-01/email', transformation_id:'STABLE_TOKEN'}
  ],
  'slice.md-group-02': [
    {dimension_ref:'MD-GROUP-02/contact_email', transformation_id:'DOMAIN_HANDLE'}
  ],
  'slice.md-order-03': [
    {dimension_ref:'MD-ORDER-03/date_of_birth', transformation_id:'BIRTH_YEAR'}
  ],
  'slice.md-loc-04': [
    {dimension_ref:'MD-LOC-04/address', transformation_id:'SERVICE_ZONE'}
  ],
  'slice.md-cross-05': [
    {dimension_ref:'MD-CROSS-05/subject_email', transformation_id:'STABLE_TOKEN'},
    {dimension_ref:'MD-CROSS-05/timestamp', transformation_id:'HOUR_BUCKET'}
  ],
  'slice.md-graph-06': [
    {dimension_ref:'MD-GRAPH-06/person_name', transformation_id:'STABLE_TOKEN'},
    {dimension_ref:'MD-GRAPH-06/source_relations', transformation_id:'RELATION_ONLY'}
  ],
  'slice.md-tool-07': [
    {dimension_ref:'MD-TOOL-07/recipient_email', transformation_id:'STABLE_TOKEN'},
    {dimension_ref:'MD-TOOL-07/address', transformation_id:'SERVICE_ZONE'}
  ]
};

test('compiler independently derives deterministic dimensions and plans for all seven seeds', () => {
  for (const seedCase of seeds.cases) {
    const first = compileDocument(
      seedCase.planner_document,
      seedCase.trusted_context,
      seedCase.trusted_catalog_slice
    );
    const second = compileDocument(
      clone(seedCase.planner_document),
      clone(seedCase.trusted_context),
      clone(seedCase.trusted_catalog_slice)
    );
    assert.deepEqual(second, first);
    assert.equal(first.status, 'FEASIBLE');
    assert.deepEqual(first.relevant_dimensions,
      seedCase.trusted_catalog_slice.dimension_refs);
    assert.deepEqual(first.selected_plan,
      EXPECTED_PLANS[seedCase.trusted_catalog_slice.slice_id]);
  }
});

test('dimension mapping works with a new operation id and never reads seed or Oracle metadata', () => {
  const seedCase = caseByTask('MD-EQ-01');
  const document = seedCase.planner_document;
  const operation = document.task_ir.operations[0];
  operation.operation_id = 'op.arbitrary_valid_deduplicate';
  const requirement = document.capability_requirements.requirements[0];
  requirement.operation_ref = operation.operation_id;
  requirement.authority_witness.support_ref = operation.operation_id;
  seedCase.trusted_context.sources[0].supports[0].support_ref = operation.operation_id;

  const result = compileDocument(
    document, seedCase.trusted_context, seedCase.trusted_catalog_slice);
  assert.equal(result.status, 'FEASIBLE');
  assert.deepEqual(result.relevant_dimensions, ['MD-EQ-01/email']);

  const compilerSource = compileDocument.toString() +
    mapRequirementsToDimensions.toString();
  assert.equal(compilerSource.includes('task_id'), false);
  assert.equal(compilerSource.includes('oracle_bridge'), false);
  assert.equal(compilerSource.includes('requirement_dimensions'), false);
});

test('missing trusted dimension and incompatible coverage return INFEASIBLE', () => {
  const cross = caseByTask('MD-CROSS-05');
  cross.trusted_catalog_slice.dimension_refs = ['MD-CROSS-05/subject_email'];
  const missing = compileDocument(
    cross.planner_document, cross.trusted_context, cross.trusted_catalog_slice);
  assert.equal(missing.status, 'INFEASIBLE');
  assert.deepEqual(missing.reasons, ['MISSING_REQUIRED_DIMENSION']);

  const loc = caseByTask('MD-LOC-04');
  const requirement = loc.planner_document.capability_requirements.requirements[0];
  requirement.capability = {
    family:'property',
    name:'geographic_region',
    parameters:{region_scheme_ref:'workflow.zone_rule'}
  };
  const uncovered = compileDocument(
    loc.planner_document, loc.trusted_context, loc.trusted_catalog_slice);
  assert.equal(uncovered.status, 'INFEASIBLE');
  assert.deepEqual(uncovered.reasons, ['NO_ACTION_PROVIDES_CAPABILITY']);
});

test('v0.2.1 negatives include all requested closure classes', () => {
  const ids = new Set(negatives.cases.map((item) => item.case_id));
  for (const id of [
    'NEG-AUTH-UNTRUSTED-EXPANSION',
    'NEG-AUTH-TRUSTED-WRONG-OPERATION',
    'NEG-AUTH-TRUSTED-WRONG-TARGET',
    'NEG-AUTH-TRUSTED-WRONG-TOOL-SCOPE',
    'NEG-SOLVER-ARBITRARY-ANSWER-METADATA',
    'NEG-SOLVER-FAKE-SAFE-UNSAFE-OUTPUT',
    'NEG-SOLVER-SOURCE-OUTPUT-PROVENANCE-MISMATCH',
    'NEG-SOLVER-OCCURRENCE-SPECIFIC-STRUCTURAL-BYPASS'
  ]) assert.equal(ids.has(id), true, id);
});
