'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const schema = loadJson('fixtures/planner-capability-schema-v0.3.json');
const ontology = loadJson('fixtures/planner-ontology-v0.3.json');
const catalog = loadJson('fixtures/planner-representation-catalog-v0.3.json');

const OWNERS = new Set([
  'OPERATION_DERIVED', 'WORKFLOW_DERIVED', 'RELATION_DERIVED',
  'TOOL_CONTRACT_DERIVED', 'ONTOLOGY_DERIVED', 'SEMANTIC_CHOICE'
]);
const FORBIDDEN_PLANNER_KEYS = new Set([
  'requirement_id', 'operation_id', 'semantic_type', 'target_role',
  'authority_proof', 'authority_witness', 'effective_boundary', 'boundary',
  'representation', 'transformation', 'compiler_action', 'dimension',
  'task_id', 'seed_id'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveRef(node, root) {
  if (!node.$ref) return node;
  assert.equal(node.$ref.startsWith('#/$defs/'), true);
  return root.$defs[node.$ref.slice('#/$defs/'.length)];
}

function schemaErrors(node, value, root = schema, at = '$') {
  node = resolveRef(node, root);
  assert.ok(node, `${at}: unresolved schema reference`);
  if (node.oneOf) {
    const matches = node.oneOf.filter((candidate) =>
      schemaErrors(candidate, value, root, at).length === 0);
    return matches.length === 1 ? [] : [`${at}: oneOf mismatch`];
  }
  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
    return [`${at}: const mismatch`];
  }
  if (node.enum && !node.enum.includes(value)) return [`${at}: enum mismatch`];
  if (node.type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected string`];
    if (node.pattern && !new RegExp(node.pattern).test(value)) return [`${at}: pattern mismatch`];
  }
  if (node.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return [`${at}: expected number`];
  }
  if (node.type === 'boolean' && typeof value !== 'boolean') return [`${at}: expected boolean`];
  if (node.type === 'array') {
    if (!Array.isArray(value)) return [`${at}: expected array`];
    if (node.minItems !== undefined && value.length < node.minItems) return [`${at}: too few items`];
    if (node.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return [`${at}: duplicate items`];
    }
    return value.flatMap((item, index) => schemaErrors(node.items, item, root, `${at}[${index}]`));
  }
  if (node.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object`];
    for (const required of node.required ?? []) {
      if (!Object.hasOwn(value, required)) return [`${at}: missing ${required}`];
    }
    const properties = node.properties ?? {};
    if (node.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return [`${at}: unexpected ${extra}`];
    }
    return Object.entries(value).flatMap(([key, item]) =>
      properties[key] ? schemaErrors(properties[key], item, root, `${at}.${key}`) : []);
  }
  if (node.type === 'integer' && !Number.isInteger(value)) return [`${at}: expected integer`];
  if (node.exclusiveMinimum !== undefined && !(value > node.exclusiveMinimum)) {
    return [`${at}: below exclusive minimum`];
  }
  return [];
}

function validPlannerDocument(document) {
  return schemaErrors(schema, document).length === 0 && semanticKernelErrors(document).length === 0;
}

function allKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
  else if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => keys.add(key));
    Object.values(value).forEach((item) => allKeys(item, keys));
  }
  return keys;
}

function semanticKernelErrors(document) {
  const errors = [];
  for (const requirement of document.semantic_kernel?.requirements ?? []) {
    const request = requirement.capability_request;
    const consumer = requirement.consumer_intent;
    if (request?.origin === 'TOOL_INFORMATION_CONTRACT' &&
        consumer?.kind !== 'DECLARED_TOOL_PARAMETER') {
      errors.push('TOOL_INFORMATION_CONTRACT_REQUIRES_TOOL_CONSUMER');
    }
    if (request?.origin === 'TASK_SEMANTIC' && consumer?.kind === 'DECLARED_TOOL_PARAMETER' &&
        request.capability_name === undefined) {
      errors.push('TASK_SEMANTIC_NAME_REQUIRED');
    }
  }
  return errors;
}

function assertClosedSchemaGraph() {
  const visited = new Set();
  function walk(node, at) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${at} is not closed`);
    if (node.properties) Object.entries(node.properties).forEach(([key, value]) => walk(value, `${at}.${key}`));
    if (node.items) walk(node.items, `${at}[]`);
    if (node.oneOf) node.oneOf.forEach((value, index) => walk(value, `${at}.oneOf[${index}]`));
  }
  walk(schema, '$');
  Object.entries(schema.$defs).forEach(([name, definition]) => walk(definition, `#/defs/${name}`));
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function ontologyErrors(value) {
  const errors = [];
  if (value.schema_version !== 'planner-ontology-v0.3') errors.push('VERSION');
  if (!Array.isArray(value.operations) || !Array.isArray(value.capabilities)) errors.push('ROOT_COLLECTIONS');
  if (new Set(value.parameter_owners).size !== OWNERS.size ||
      value.parameter_owners.some((owner) => !OWNERS.has(owner))) errors.push('OWNER_VOCABULARY');
  const rules = new Map((value.derivation_rules ?? []).map((rule) => [rule.derivation_rule_ref, rule]));
  const operationRefs = new Set();
  for (const operation of value.operations ?? []) {
    if (operationRefs.has(operation.operation_ref)) errors.push('DUPLICATE_OPERATION');
    operationRefs.add(operation.operation_ref);
    const operationParameterNames = (operation.parameter_declarations ?? []).map((item) => item.name);
    if (new Set(operationParameterNames).size !== operationParameterNames.length) errors.push('DUPLICATE_OPERATION_PARAMETER');
    for (const parameter of operation.parameter_declarations ?? []) {
      if (!parameter.owner || !parameter.derivation_rule_ref || !parameter.value_schema) errors.push('OPERATION_PARAMETER_INCOMPLETE');
      if (!OWNERS.has(parameter.owner) || !rules.has(parameter.derivation_rule_ref)) errors.push('OPERATION_PARAMETER_UNKNOWN_OWNER_OR_RULE');
      if (rules.get(parameter.derivation_rule_ref)?.owner !== parameter.owner) errors.push('OPERATION_PARAMETER_OWNER_MISMATCH');
    }
  }
  const capabilityRefs = new Set();
  for (const capability of value.capabilities ?? []) {
    if (capabilityRefs.has(capability.capability_ref)) errors.push('DUPLICATE_CAPABILITY');
    capabilityRefs.add(capability.capability_ref);
    const capabilityParameterNames = (capability.parameter_declarations ?? []).map((item) => item.name);
    if (new Set(capabilityParameterNames).size !== capabilityParameterNames.length) errors.push('DUPLICATE_CAPABILITY_PARAMETER');
    for (const operationRef of capability.allowed_operation_refs ?? []) {
      if (!operationRefs.has(operationRef)) errors.push('CAPABILITY_UNKNOWN_OPERATION');
    }
    for (const parameter of capability.parameter_declarations ?? []) {
      if (!parameter.owner || !parameter.derivation_rule_ref || !parameter.value_schema) errors.push('CAPABILITY_PARAMETER_INCOMPLETE');
      if (!OWNERS.has(parameter.owner) || !rules.has(parameter.derivation_rule_ref)) errors.push('CAPABILITY_PARAMETER_UNKNOWN_OWNER_OR_RULE');
      if (rules.get(parameter.derivation_rule_ref)?.owner !== parameter.owner) errors.push('CAPABILITY_PARAMETER_OWNER_MISMATCH');
    }
  }
  return errors;
}

function relationIdentityContract(capability, ontologyValue = ontology) {
  if (capability.dimension_kind !== 'RELATION_DIMENSION') return false;
  const capabilityConstraints = new Set(capability.generic_compatibility_constraints ?? []);
  const operations = new Map(ontologyValue.operations.map((item) => [item.operation_ref, item]));
  return capability.allowed_operation_refs.length > 0 &&
    capabilityConstraints.has('SOURCE_RELATION_REQUIRED') &&
    capabilityConstraints.has('ENDPOINTS_MATCH_DECLARATION') &&
    capability.allowed_target_roles.includes('RELATION_SOURCE') &&
    capability.allowed_operation_refs.every((operationRef) => {
      const operation = operations.get(operationRef);
      const constraints = new Set(operation?.generic_compatibility_constraints ?? []);
      return constraints.has('SOURCE_RELATION_REQUIRED') &&
        constraints.has('ENDPOINTS_MATCH_DECLARATION') &&
        operation.input_slots.some((slot) => slot.target_role === 'RELATION_SOURCE');
    });
}

function canonicalDimensionKey(capability, input, ontologyValue = ontology) {
  if (capability.dimension_kind === 'FIELD_DIMENSION') {
    if (!Array.isArray(input.target_selectors) || input.target_selectors.length === 0) {
      return {status: 'ONTOLOGY_INVALID'};
    }
    return `FIELD_DIMENSION:${JSON.stringify([...input.target_selectors].sort())}`;
  }
  if (capability.dimension_kind === 'RELATION_DIMENSION') {
    if (!relationIdentityContract(capability, ontologyValue) ||
        typeof input.relation_ref !== 'string' || input.relation_ref.length === 0 ||
        !Array.isArray(input.endpoint_selectors) || input.endpoint_selectors.length === 0) {
      return {status: 'ONTOLOGY_INVALID'};
    }
    return `RELATION_DIMENSION:${input.relation_ref}:${JSON.stringify([...input.endpoint_selectors].sort())}`;
  }
  return {status: 'ONTOLOGY_INVALID'};
}

const VALID_SEMANTIC_TYPES = new Set(schema.$defs.semantic_type.enum);
const VALID_BOUNDARIES = new Set(['AGENT', 'TOOL']);
const VALID_OWNERS = new Set(['USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA', 'RUNTIME_CAPABILITY']);

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function predicateError(predicate, capability) {
  if (!predicate || typeof predicate !== 'object') return 'PREDICATE_INVALID';
  const declaration = capability.parameter_declarations.find((item) => item.name === predicate.parameter);
  if (!declaration || typeof predicate.operator !== 'string') return 'PREDICATE_PARAMETER_INVALID';
  if (predicate.operator === 'EQUALS') {
    const allowed = declaration.value_schema.enum;
    if (allowed && !allowed.includes(predicate.value)) return 'PREDICATE_VALUE_INVALID';
    return null;
  }
  if (predicate.operator === 'ONE_OF') {
    if (!Array.isArray(predicate.values) || predicate.values.length === 0) return 'PREDICATE_VALUE_INVALID';
    const allowed = declaration.value_schema.enum;
    if (allowed && predicate.values.some((value) => !allowed.includes(value))) return 'PREDICATE_VALUE_INVALID';
    return null;
  }
  if (['TRUSTED_DECLARATION_REF', 'TRUSTED_WORKFLOW_REF', 'DECLARED_RELATION_VALUE'].includes(predicate.operator)) return null;
  return 'PREDICATE_OPERATOR_INVALID';
}

function catalogStructuralError(value) {
  const rootKeys = ['\u0024schema', '\u0024id', 'title', 'description', 'catalog_version', 'finite_space', 'deterministic_serialization', 'boundary_policy', 'infeasibility_reasons', 'templates'];
  if (!value || !exactKeys(value, rootKeys) || value.catalog_version !== 'planner-representation-catalog-v0.3' || value.finite_space !== true) return 'CATALOG_STRUCTURE_INVALID';
  const capabilityMap = new Map(ontology.capabilities.map((item) => [item.capability_ref, item]));
  const operationMap = new Map(ontology.operations.map((item) => [item.operation_ref, item]));
  const templateIds = new Set();
  const actions = new Map();
  const templateKeys = ['template_id', 'dimension_kind', 'applicable_semantic_types', 'applicable_selector_shape', 'capability_coverage', 'capability_parameter_predicates', 'effective_boundary_coverage', 'required_trusted_preconditions', 'transformation_contract', 'disclosure_rank', 'canonical_action_template', 'no_solver_invariants'];
  const shapeKeys = ['shape', 'min_arity', 'max_arity', 'required_target_roles'];
  const boundaryKeys = ['boundary', 'required_preconditions'];
  const preconditionKeys = ['precondition_ref', 'owner_class', 'evidence_kind'];
  const transformationKeys = ['source_binding', 'output_binding', 'derivation_kind', 'occurrence_policy', 'metadata_policy', 'relation_provenance', 'field_local', 'occurrence_local', 'uniform_across_records', 'preserves_existing_relation', 'depends_on_task_answer', 'selects_subset', 'introduces_rank', 'introduces_aggregate', 'introduces_derived_relation'];
  const actionKeys = ['action_id', 'action_kind', 'transformation', 'parameters'];
  for (const template of value.templates ?? []) {
    if (!exactKeys(template, templateKeys)) return 'CATALOG_STRUCTURE_INVALID';
    if (templateIds.has(template.template_id) || !/^template\.(field|relation)\.[a-z][a-z0-9_.-]*$/.test(template.template_id)) return 'CATALOG_STRUCTURE_INVALID';
    templateIds.add(template.template_id);
    if (!['FIELD_DIMENSION', 'RELATION_DIMENSION'].includes(template.dimension_kind)) return 'CATALOG_STRUCTURE_INVALID';
    if (!template.applicable_semantic_types.every((type) => VALID_SEMANTIC_TYPES.has(type))) return 'CATALOG_INVALID';
    if (!exactKeys(template.applicable_selector_shape, shapeKeys) || template.applicable_selector_shape.min_arity < 1 || template.applicable_selector_shape.max_arity < template.applicable_selector_shape.min_arity) return 'CATALOG_STRUCTURE_INVALID';
    if (!template.applicable_selector_shape.required_target_roles.every((role) => schema.$defs.target_role.enum.includes(role))) return 'CATALOG_INVALID';
    for (const coverage of template.capability_coverage) {
      const capability = capabilityMap.get(coverage.capability_ref);
      if (!capability) return 'CAPABILITY_UNKNOWN';
      if (capability.dimension_kind !== template.dimension_kind) return 'DIMENSION_KIND_MISMATCH';
    }
    for (const predicateGroup of template.capability_parameter_predicates) {
      const capability = capabilityMap.get(predicateGroup.capability_ref);
      if (!capability || !template.capability_coverage.some((item) => item.capability_ref === predicateGroup.capability_ref)) return 'PREDICATE_CAPABILITY_UNKNOWN';
      if (predicateGroup.predicates.some((predicate) => predicateError(predicate, capability))) return 'PREDICATE_INVALID';
    }
    for (const boundary of template.effective_boundary_coverage) {
      if (!exactKeys(boundary, boundaryKeys) || !VALID_BOUNDARIES.has(boundary.boundary) || !boundary.required_preconditions.every((ref) => typeof ref === 'string')) return 'CATALOG_STRUCTURE_INVALID';
    }
    const preconditionRefs = new Set();
    for (const precondition of template.required_trusted_preconditions) {
      if (!exactKeys(precondition, preconditionKeys) || !VALID_OWNERS.has(precondition.owner_class) || typeof precondition.precondition_ref !== 'string' || typeof precondition.evidence_kind !== 'string') return 'CATALOG_STRUCTURE_INVALID';
      preconditionRefs.add(precondition.precondition_ref);
    }
    for (const boundary of template.effective_boundary_coverage) {
      if (boundary.required_preconditions.some((ref) => !preconditionRefs.has(ref))) return 'UNPROVED_TRUSTED_PRECONDITION';
    }
    if (!exactKeys(template.transformation_contract, transformationKeys)) return 'CATALOG_STRUCTURE_INVALID';
    if (template.transformation_contract.depends_on_task_answer || template.transformation_contract.selects_subset || template.transformation_contract.introduces_rank || template.transformation_contract.introduces_aggregate || template.transformation_contract.introduces_derived_relation || !template.transformation_contract.uniform_across_records) return 'NO_SOLVER_INVARIANT_VIOLATION';
    if (template.dimension_kind === 'FIELD_DIMENSION' && (template.transformation_contract.source_binding !== 'DIMENSION_TARGET_FIELDS' || template.transformation_contract.output_binding !== 'SAME_SOURCE_OCCURRENCES' || template.transformation_contract.relation_provenance !== 'NOT_APPLICABLE')) return 'DIMENSION_KIND_MISMATCH';
    if (template.dimension_kind === 'RELATION_DIMENSION' && (template.applicable_selector_shape.shape !== 'ENDPOINT_SELECTOR_SET' || template.transformation_contract.source_binding !== 'DECLARED_RELATION_ENDPOINTS' || template.transformation_contract.output_binding !== 'SOURCE_RELATION_SAME_EDGES' || template.transformation_contract.relation_provenance !== 'SOURCE_DECLARED_ONLY' || !template.required_trusted_preconditions.some((item) => item.precondition_ref === 'precondition.source_relation_declared'))) return 'RELATION_CONTRACT_INVALID';
    if (!Number.isInteger(template.disclosure_rank) || template.disclosure_rank < 0 || !exactKeys(template.canonical_action_template, actionKeys)) return 'CATALOG_STRUCTURE_INVALID';
    const action = template.canonical_action_template;
    const previous = actions.get(action.action_id);
    if (previous && (stableJson(previous.action) !== stableJson(action) || previous.rank !== template.disclosure_rank)) return 'CATALOG_INVALID';
    actions.set(action.action_id, {action, rank: template.disclosure_rank});
    if (!Array.isArray(template.no_solver_invariants) || template.no_solver_invariants.length === 0) return 'NO_SOLVER_INVARIANT_VIOLATION';
  }
  if (!operationMap.size) return 'ONTOLOGY_INVALID';
  return null;
}

function constructDimensions(requirements, ontologyValue = ontology) {
  const capabilityMap = new Map(ontologyValue.capabilities.map((item) => [item.capability_ref, item]));
  const dimensions = new Map();
  for (const requirement of requirements) {
    const capability = capabilityMap.get(requirement.capability_ref);
    if (!capability || requirement.dimension_kind && requirement.dimension_kind !== capability.dimension_kind) return {status: 'ONTOLOGY_INVALID'};
    const keyInput = capability.dimension_kind === 'FIELD_DIMENSION'
      ? {target_selectors: requirement.target_selectors}
      : {relation_ref: requirement.relation_ref, endpoint_selectors: requirement.endpoint_selectors};
    const key = canonicalDimensionKey(capability, keyInput, ontologyValue);
    if (typeof key !== 'string') return key;
    if (!dimensions.has(key)) dimensions.set(key, {key, dimension_kind: capability.dimension_kind, semantic_types: new Set(), target_roles: new Set(), requirements: []});
    const dimension = dimensions.get(key);
    (requirement.semantic_types ?? []).forEach((type) => dimension.semantic_types.add(type));
    (requirement.target_roles ?? []).forEach((role) => dimension.target_roles.add(role));
    dimension.requirements.push(requirement);
  }
  return {status: 'OK', dimensions: [...dimensions.values()].sort((left, right) => left.dimension_kind.localeCompare(right.dimension_kind) || left.key.localeCompare(right.key))};
}

function predicateMatches(predicate, requirement) {
  const actual = requirement.parameters?.[predicate.parameter];
  if (predicate.operator === 'EQUALS') return actual === predicate.value;
  if (predicate.operator === 'ONE_OF') return predicate.values.includes(actual);
  if (predicate.operator === 'TRUSTED_DECLARATION_REF') return typeof actual === 'string' && /^(workflow|schema)\.[a-z][a-z0-9_.-]*$/.test(actual);
  if (predicate.operator === 'TRUSTED_WORKFLOW_REF') return typeof actual === 'string' && /^workflow\.[a-z][a-z0-9_.-]*$/.test(actual);
  if (predicate.operator === 'DECLARED_RELATION_VALUE') return typeof actual === 'string' && actual.length > 0;
  return false;
}

function coverageCapabilityMatches(coverage, requirement, template) {
  if (coverage.capability_ref !== requirement.capability_ref) return false;
  const group = template.capability_parameter_predicates.find((item) => item.capability_ref === coverage.capability_ref);
  return !group || group.predicates.every((predicate) => predicateMatches(predicate, requirement));
}

function actionSatisfies(template, requirements) {
  return requirements.every((requirement) => {
    const boundary = template.effective_boundary_coverage.find((item) => item.boundary === requirement.boundary);
    if (!boundary) return false;
    const available = new Set(requirement.available_preconditions ?? []);
    if (boundary.required_preconditions.some((precondition) => !available.has(precondition))) return false;
    return template.capability_coverage.some((coverage) => coverageCapabilityMatches(coverage, requirement, template));
  });
}

function templateMatches(template, dimension) {
  if (template.dimension_kind !== dimension.dimension_kind) return false;
  const shape = template.applicable_selector_shape;
  const selectorCount = dimension.dimension_kind === 'FIELD_DIMENSION'
    ? dimension.requirements[0].target_selectors.length
    : dimension.requirements[0].endpoint_selectors.length;
  if (selectorCount < shape.min_arity || selectorCount > shape.max_arity) return false;
  if (![...dimension.semantic_types].every((type) => template.applicable_semantic_types.includes(type))) return false;
  if (![...shape.required_target_roles].every((role) => dimension.target_roles.has(role))) return false;
  return actionSatisfies(template, dimension.requirements);
}

function candidateTemplates(requirements, catalogValue = catalog) {
  const structuralError = catalogStructuralError(catalogValue);
  if (structuralError) return {status: structuralError};
  const resolved = constructDimensions(requirements);
  if (resolved.status !== 'OK') return resolved;
  const candidates = resolved.dimensions.map((dimension) => ({
    dimension,
    templates: catalogValue.templates.filter((template) => templateMatches(template, dimension))
  }));
  if (candidates.some((item) => item.templates.length === 0)) return {status: 'INFEASIBLE', candidates};
  return {status: 'CANDIDATES', candidates};
}

function enumeratePlans(candidates, index = 0, current = [], plans = []) {
  if (index === candidates.length) return plans.concat([current]);
  return candidates[index].templates.reduce((all, template) =>
    enumeratePlans(candidates, index + 1, current.concat(template), all), plans);
}

function rankVector(plan) {
  return plan.map((template) => template.disclosure_rank);
}

function paretoMinimal(plans) {
  return plans.filter((candidate, candidateIndex) => !plans.some((other, otherIndex) => {
    if (candidateIndex === otherIndex) return false;
    const candidateRanks = rankVector(candidate);
    const otherRanks = rankVector(other);
    return otherRanks.every((rank, index) => rank <= candidateRanks[index]) &&
      otherRanks.some((rank, index) => rank < candidateRanks[index]);
  }));
}

function selectPlan(requirements, catalogValue = catalog) {
  const resolved = candidateTemplates(requirements, catalogValue);
  if (resolved.status !== 'CANDIDATES') return resolved;
  const plans = enumeratePlans(resolved.candidates);
  const pareto = paretoMinimal(plans);
  pareto.sort((left, right) => {
    const leftKey = stableJson([rankVector(left), left.map((template) => template.canonical_action_template)]);
    const rightKey = stableJson([rankVector(right), right.map((template) => template.canonical_action_template)]);
    return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
  });
  return {status: 'FEASIBLE', candidate_count: plans.length, pareto_count: pareto.length, selected_action_ids: pareto[0].map((template) => template.canonical_action_template.action_id), dimensions: resolved.candidates.map((item) => item.dimension.key)};
}

function plannerDocument() {
  return {
    schema_version: 'planner-capability-schema-v0.3',
    task_ir: {
      task_ir_version: 'task-ir-v0.3',
      operations: [{
        planner_local_ref: 'local.group',
        family: 'group_by',
        input_bindings: [{slot_ref: 'group_key', field_ref: 'contact_email'}],
        parameters: {granularity: 'EMAIL_DOMAIN'},
        depends_on: [],
        result_shape: 'groups'
      }],
      presentation_constraints: []
    },
    semantic_kernel: {
      semantic_kernel_version: 'minimal-semantic-kernel-v0.3',
      requirements: [{
        operation_binding: 'local.group',
        target_input_selectors: ['group_key'],
        capability_request: {
          origin: 'TASK_SEMANTIC',
          capability_name: 'domain',
          semantic_parameters: {}
        },
        semantic_scope_intent: {kind: 'INPUT_RECORD_SET'},
        consumer_intent: {kind: 'AGENT_COMPUTATION'}
      }]
    },
    uncertainty: 'CONFIDENT'
  };
}

function completedRequirement() {
  return {
    requirement_id: 'req.001',
    operation_ref: 'op.001',
    target_input_selectors: ['group_key'],
    capability: {family: 'property', name: 'domain', parameters: {granularity: 'EMAIL_DOMAIN'}},
    scope: {kind: 'INPUT_RECORD_SET'},
    consumer_intent: {kind: 'AGENT_COMPUTATION'},
    semantic_requirement_hash: `sha256.${'a'.repeat(64)}`
  };
}

test('v0.3 schema is a closed object graph and validates a Planner IR positive', () => {
  assertClosedSchemaGraph();
  assert.deepEqual(schema.properties.schema_version.const, 'planner-capability-schema-v0.3');
  assert.equal(validPlannerDocument(plannerDocument()), true);
});

test('Planner output cannot emit derived, proof, boundary, representation, or task-qualified fields', () => {
  const forbidden = [...FORBIDDEN_PLANNER_KEYS];
  for (const key of forbidden) {
    const candidate = plannerDocument();
    candidate.semantic_kernel.requirements[0][key] = key === 'semantic_type' ? 'EMAIL' : 'x';
    assert.equal(schemaErrors(schema, candidate).length === 0, false, key);
  }
  const operation = plannerDocument().task_ir.operations[0];
  for (const key of ['operation_id', 'semantic_type', 'target_role', 'effective_boundary', 'representation']) {
    const candidate = plannerDocument();
    candidate.task_ir.operations[0][key] = 'x';
    assert.equal(schemaErrors(schema, candidate).length === 0, false, `operation.${key}`);
  }
  assert.equal(allKeys(plannerDocument()).has('authority_witness'), false);
  assert.equal(allKeys(plannerDocument()).has('task_id'), false);
  assert.equal(operation.planner_local_ref.startsWith('local.'), true);
});

test('semantic types, target roles, and capability families are ontology completion facts', () => {
  const operation = ontology.operations.find((item) => item.operation_ref === 'operation.group_by');
  const capability = ontology.capabilities.find((item) => item.name === 'domain');
  assert.ok(operation);
  assert.ok(capability);
  assert.ok(operation.input_slots.every((slot) => slot.target_role && slot.allowed_semantic_types.length > 0));
  assert.ok(capability.family && capability.dimension_kind);
  assert.equal(Object.hasOwn(plannerDocument().task_ir.operations[0].input_bindings[0], 'semantic_type'), false);
  assert.equal(Object.hasOwn(plannerDocument().semantic_kernel.requirements[0], 'target_role'), false);
});

test('all operation and capability parameter declarations have one owner and one derivation rule', () => {
  assert.deepEqual(ontologyErrors(ontology), []);
  const missingOwner = clone(ontology);
  delete missingOwner.capabilities.find((item) => item.name === 'domain').parameter_declarations[0].owner;
  assert.ok(ontologyErrors(missingOwner).includes('CAPABILITY_PARAMETER_INCOMPLETE'));
  const missingRule = clone(ontology);
  delete missingRule.capabilities.find((item) => item.name === 'domain').parameter_declarations[0].derivation_rule_ref;
  assert.ok(ontologyErrors(missingRule).includes('CAPABILITY_PARAMETER_INCOMPLETE'));
  const duplicate = clone(ontology);
  duplicate.capabilities.find((item) => item.name === 'domain').parameter_declarations.push({name: 'granularity', owner: 'OPERATION_DERIVED', derivation_rule_ref: 'rule.operation.domain_granularity', value_schema: {type: 'string'}});
  assert.ok(ontologyErrors(duplicate).includes('DUPLICATE_CAPABILITY_PARAMETER'));
});

test('Tool information contract requiredness is separate from ordinary Tool schema requiredness', () => {
  const parameter = {tool_ref: 'tool.mail', parameter_ref: 'tool.mail.recipient', semantic_type: 'EMAIL', required: true};
  const contract = {
    contract_id: 'contract.mail.recipient',
    tool_ref: 'tool.mail',
    parameter_ref: 'tool.mail.recipient',
    accepted_source_semantic_types: ['EMAIL'],
    required_capability: {name: 'exact_value', parameters: {}},
    minimum_information_semantics: 'EXACT_SOURCE_VALUE',
    issuer: 'mail-contracts',
    version: 'v1.0'
  };
  assert.deepEqual(schemaErrors(schema.$defs.tool_parameter_schema, parameter), []);
  assert.deepEqual(schemaErrors(schema.$defs.tool_information_contract, contract), []);
  assert.equal(Object.hasOwn(contract, 'required'), false);
  const noContract = plannerDocument();
  noContract.semantic_kernel.requirements[0].capability_request = {origin: 'TOOL_INFORMATION_CONTRACT'};
  noContract.semantic_kernel.requirements[0].consumer_intent = {kind: 'DECLARED_TOOL_PARAMETER', tool_ref: 'tool.mail', parameter_ref: 'tool.mail.recipient'};
  assert.equal(validPlannerDocument(noContract), true);
  assert.equal(contract.required_capability.name, 'exact_value');
});

test('capability request origin is a fail-closed semantic discriminant', () => {
  const invalidConsumer = plannerDocument();
  invalidConsumer.semantic_kernel.requirements[0].capability_request = {origin: 'TOOL_INFORMATION_CONTRACT'};
  assert.deepEqual(semanticKernelErrors(invalidConsumer), ['TOOL_INFORMATION_CONTRACT_REQUIRES_TOOL_CONSUMER']);
  const invalidBranch = plannerDocument();
  invalidBranch.semantic_kernel.requirements[0].capability_request = {
    origin: 'TOOL_INFORMATION_CONTRACT',
    capability_name: 'exact_value'
  };
  assert.notDeepEqual(schemaErrors(schema, invalidBranch), []);
});

test('AuthorityProof is separate from semantic identity and effective boundary', () => {
  const semantic = completedRequirement();
  assert.deepEqual(schemaErrors(schema.$defs.completed_semantic_requirement, semantic), []);
  assert.equal(Object.hasOwn(semantic, 'authority_proof'), false);
  assert.equal(Object.hasOwn(semantic, 'effective_boundary'), false);
  const proof = {
    semantic_requirement_hash: semantic.semantic_requirement_hash,
    context_snapshot_id: 'snapshot.ctx.v03',
    field_proofs: [{
      claim_path: 'capability.name',
      owner_class: 'GLOBAL_ONTOLOGY',
      source_id: 'ontology.planner.v0.3',
      support_type: 'ONTOLOGY_DECLARATION',
      support_ref: 'capability.domain',
      narrowing_relation: 'EXACT_MATCH'
    }],
    decision: 'AUTHORIZED'
  };
  assert.deepEqual(schemaErrors(schema.$defs.authority_proof, proof), []);
  const contaminated = clone(semantic);
  contaminated.authority_proof = proof;
  assert.notDeepEqual(schemaErrors(schema.$defs.completed_semantic_requirement, contaminated), []);
});

test('effective boundary, four evaluator axes, and fail-closed terminals are machine-readable', () => {
  const hash = `sha256.${'b'.repeat(64)}`;
  const boundary = {
    semantic_requirement_hash: hash,
    status: 'DERIVED',
    boundary: 'AGENT',
    consumer_intent: {kind: 'AGENT_COMPUTATION'},
    release_decision: {operation_and_destination_authorized: true, tool_only_release_authorized: false},
    runtime_capability: {agent_non_observation_supported: false, atomic_restoration_supported: false, runtime_mediator_identity: 'runtime.mediator'}
  };
  assert.deepEqual(schemaErrors(schema.$defs.effective_boundary_decision, boundary), []);
  const terminal = {semantic_requirement_hash: hash, status: 'UNSUPPORTED', reason_code: 'MISSING_TOOL_INFORMATION_CONTRACT'};
  assert.deepEqual(schemaErrors(schema.$defs.effective_boundary_decision, terminal), []);
  const result = {
    semantic_requirement_correctness: {status: 'PASS', diagnostics: []},
    authority_proof_validity: {status: 'NOT_EVALUATED', diagnostics: ['INSUFFICIENT_AUTHORITY']},
    effective_boundary_release_policy_correctness: {status: 'NOT_EVALUATED', diagnostics: []},
    compiler_feasibility_minimality: {status: 'NOT_EVALUATED', diagnostics: []},
    terminal_status: 'INSUFFICIENT_AUTHORITY'
  };
  assert.deepEqual(schemaErrors(schema.$defs.evaluator_result, result), []);
  for (const status of ['AMBIGUOUS', 'UNSUPPORTED', 'INSUFFICIENT_AUTHORITY', 'INFEASIBLE', 'ONTOLOGY_INVALID', 'CATALOG_INVALID']) {
    assert.equal(schema.$defs.terminal_status.enum.includes(status), true, status);
  }
});

test('ontology is global, operation/capability references are closed, and no task-qualified selectors exist', () => {
  assert.equal(ontology.operations.length, 14);
  assert.equal(ontology.capabilities.length, 14);
  assert.deepEqual(ontologyErrors(ontology), []);
  const serialized = JSON.stringify(ontology).toLowerCase();
  for (const forbidden of ['md-', 'task_id', 'seed_id', 'gold', 'oracle', 'trusted_catalog_slice', 'expected action']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const capabilityNames = new Set(ontology.capabilities.map((item) => item.name));
  assert.equal(capabilityNames.has('exact_value'), true);
  assert.equal(ontology.capabilities.every((item) => item.allowed_operation_refs.length > 0), true);
  assert.equal(ontology.capabilities.every((item) => item.dimension_kind), true);
});

test('dimension-key totality keeps linkage field-local and requires source relations only for relation dimensions', () => {
  const linkage = ontology.capabilities.find((item) => item.name === 'linkage');
  assert.equal(linkage.dimension_kind, 'FIELD_DIMENSION');
  for (const capability of ontology.capabilities.filter((item) => item.dimension_kind === 'FIELD_DIMENSION')) {
    const selectors = Array.from({length: capability.arity.min}, (_, index) => `slot.${String(index + 1).padStart(3, '0')}`);
    const key = canonicalDimensionKey(capability, {target_selectors: selectors});
    assert.equal(typeof key, 'string', capability.name);
    assert.match(key, /^FIELD_DIMENSION:/);
  }
  for (const capability of ontology.capabilities.filter((item) => item.dimension_kind === 'RELATION_DIMENSION')) {
    assert.equal(relationIdentityContract(capability), true, capability.name);
    const selectors = Array.from({length: capability.arity.min}, (_, index) => `endpoint.${String(index + 1).padStart(3, '0')}`);
    const key = canonicalDimensionKey(capability, {
      relation_ref: 'relation.source_declared',
      endpoint_selectors: selectors
    });
    assert.equal(typeof key, 'string', capability.name);
    assert.match(key, /^RELATION_DIMENSION:relation\.source_declared:/);
  }
});

test('a relation dimension without a total relation-key constructor is ONTOLOGY_INVALID', () => {
  const brokenOntology = clone(ontology);
  const broken = brokenOntology.capabilities.find((item) => item.name === 'directionality');
  for (const operationRef of broken.allowed_operation_refs) {
    const operation = brokenOntology.operations.find((item) => item.operation_ref === operationRef);
    operation.generic_compatibility_constraints = operation.generic_compatibility_constraints
      .filter((constraint) => constraint !== 'SOURCE_RELATION_REQUIRED');
  }
  assert.equal(relationIdentityContract(broken, brokenOntology), false);
  assert.deepEqual(canonicalDimensionKey(broken, {
    endpoint_selectors: ['endpoint.001', 'endpoint.002']
  }, brokenOntology), {status: 'ONTOLOGY_INVALID'});
});

test('dimension-key construction has no catalog, task, seed, Gold, Oracle, or trusted-slice dependency', () => {
  const source = relationIdentityContract.toString() + canonicalDimensionKey.toString();
  for (const forbidden of ['catalog', 'task_id', 'seed_id', 'gold', 'oracle', 'trusted_catalog_slice']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
  const relation = ontology.capabilities.find((item) => item.dimension_kind === 'RELATION_DIMENSION');
  assert.deepEqual(canonicalDimensionKey(relation, {
    endpoint_selectors: ['endpoint.001', 'endpoint.002']
  }), {status: 'ONTOLOGY_INVALID'});
});

test('global catalog is structurally valid, task-agnostic, and covers only ontology capabilities', () => {
  assert.equal(catalogStructuralError(catalog), null);
  assert.equal(catalog.templates.length, 7);
  assert.equal(catalog.templates.filter((item) => item.dimension_kind === 'FIELD_DIMENSION').length, 6);
  assert.equal(catalog.templates.filter((item) => item.dimension_kind === 'RELATION_DIMENSION').length, 1);
  assert.deepEqual([...new Set(catalog.templates.map((item) => item.transformation_contract.derivation_kind))].sort(), [
    'DECLARED_PROPERTY_EXTRACTION', 'DECLARED_SET_MEMBERSHIP', 'IDENTITY', 'REDACTION',
    'SOURCE_RELATION_PRESERVATION', 'STABLE_TOKENIZATION', 'TRUSTED_FIELD_LOCAL_COARSENING'
  ].sort());
  const serialized = JSON.stringify(catalog).toLowerCase();
  for (const forbidden of ['task_id', 'seed_id', 'md-', 'gold', 'oracle', 'expected action', 'trusted_catalog_slice', 'dimension_ref', 'benchmark']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('catalog structural negatives fail closed without task-specific exceptions', () => {
  const unknownCapability = clone(catalog);
  unknownCapability.templates[1].capability_coverage[0].capability_ref = 'capability.unknown';
  assert.equal(catalogStructuralError(unknownCapability), 'CAPABILITY_UNKNOWN');

  const invalidSemanticType = clone(catalog);
  invalidSemanticType.templates[0].applicable_semantic_types.push('SECRET_VALUE');
  assert.equal(catalogStructuralError(invalidSemanticType), 'CATALOG_INVALID');

  const invalidTemplateId = clone(catalog);
  invalidTemplateId.templates[0].template_id = 'template.field.MD-EQ-01';
  assert.equal(catalogStructuralError(invalidTemplateId), 'CATALOG_STRUCTURE_INVALID');

  const invalidPredicate = clone(catalog);
  invalidPredicate.templates[1].capability_parameter_predicates[0].predicates[0].parameter = 'task_id';
  assert.equal(catalogStructuralError(invalidPredicate), 'PREDICATE_INVALID');

  const malformedPrecondition = clone(catalog);
  delete malformedPrecondition.templates.find((item) => item.template_id === 'template.relation.source_preservation').required_trusted_preconditions[0].owner_class;
  assert.equal(catalogStructuralError(malformedPrecondition), 'CATALOG_STRUCTURE_INVALID');

  const fieldAsRelation = clone(catalog);
  fieldAsRelation.templates[0].dimension_kind = 'RELATION_DIMENSION';
  assert.equal(catalogStructuralError(fieldAsRelation), 'RELATION_CONTRACT_INVALID');

  const relationWithoutContract = clone(catalog);
  const relationTemplate = relationWithoutContract.templates.find((item) => item.dimension_kind === 'RELATION_DIMENSION');
  relationTemplate.transformation_contract.relation_provenance = 'NOT_APPLICABLE';
  assert.equal(catalogStructuralError(relationWithoutContract), 'RELATION_CONTRACT_INVALID');

  const unknownPredicateCapability = clone(catalog);
  unknownPredicateCapability.templates[1].capability_parameter_predicates.push({capability_ref: 'capability.exact_value', predicates: []});
  assert.equal(catalogStructuralError(unknownPredicateCapability), 'PREDICATE_CAPABILITY_UNKNOWN');

  const canonicalActionConflict = clone(catalog);
  const canonicalCopy = clone(catalog.templates[0]);
  canonicalCopy.template_id = 'template.field.redaction_alt';
  canonicalCopy.canonical_action_template.action_kind = 'DIFFERENT_ACTION';
  canonicalActionConflict.templates.push(canonicalCopy);
  assert.equal(catalogStructuralError(canonicalActionConflict), 'CATALOG_INVALID');

  const rankConflict = clone(catalog);
  const rankCopy = clone(catalog.templates[0]);
  rankCopy.template_id = 'template.field.redaction_rank_conflict';
  rankCopy.disclosure_rank = 9;
  rankConflict.templates.push(rankCopy);
  assert.equal(catalogStructuralError(rankConflict), 'CATALOG_INVALID');
});

function fieldRequirement(capability_ref, parameters, overrides = {}) {
  return {
    capability_ref,
    dimension_kind: 'FIELD_DIMENSION',
    target_selectors: overrides.target_selectors ?? ['slot.001'],
    semantic_types: overrides.semantic_types ?? ['EMAIL'],
    target_roles: overrides.target_roles ?? ['VALUE'],
    parameters,
    boundary: overrides.boundary ?? 'AGENT',
    available_preconditions: overrides.available_preconditions ?? []
  };
}

function relationRequirement(capability_ref, parameters, overrides = {}) {
  return {
    capability_ref,
    dimension_kind: 'RELATION_DIMENSION',
    relation_ref: overrides.relation_ref ?? 'relation.source_declared',
    endpoint_selectors: overrides.endpoint_selectors ?? ['endpoint.001', 'endpoint.002'],
    semantic_types: overrides.semantic_types ?? ['PERSON_NAME'],
    target_roles: overrides.target_roles ?? ['RELATION_SOURCE', 'RELATION_TARGET'],
    parameters,
    boundary: overrides.boundary ?? 'AGENT',
    available_preconditions: overrides.available_preconditions ?? []
  };
}

test('structural dimension mapping aggregates same field keys and orders fields before relations', () => {
  const requirements = [
    fieldRequirement('capability.identity', {stability_scope: 'TASK'}, {target_selectors: ['slot.002', 'slot.001']}),
    fieldRequirement('capability.equality', {equality_basis: 'FIELD_VALUE'}, {target_selectors: ['slot.001', 'slot.002']}),
    relationRequirement('capability.existing_relation', {relation_orientation: 'DIRECTED', relation_source: 'SOURCE_DECLARED'}, {available_preconditions: ['precondition.source_relation_declared']})
  ];
  const result = constructDimensions(requirements);
  assert.equal(result.status, 'OK');
  assert.equal(result.dimensions.length, 2);
  assert.equal(result.dimensions[0].dimension_kind, 'FIELD_DIMENSION');
  assert.equal(result.dimensions[1].dimension_kind, 'RELATION_DIMENSION');
  assert.equal(result.dimensions[0].requirements.length, 2);
  assert.equal(result.dimensions[0].key, 'FIELD_DIMENSION:["slot.001","slot.002"]');
});

test('dimension construction and catalog matching do not infer dimensions from catalog feasibility', () => {
  const requirement = fieldRequirement('capability.identity', {stability_scope: 'TASK'});
  const before = clone(requirement);
  const source = constructDimensions.toString() + canonicalDimensionKey.toString() + relationIdentityContract.toString();
  for (const forbidden of ['catalog', 'task_id', 'seed_id', 'gold', 'oracle', 'trusted_catalog_slice']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
  const result = selectPlan([requirement]);
  assert.equal(result.status, 'FEASIBLE');
  assert.deepEqual(requirement, before);
});

test('zero satisfying actions is INFEASIBLE and multiple satisfying actions are compiler candidates, not AMBIGUOUS', () => {
  const relationWithoutEvidence = relationRequirement('capability.directionality', {relation_orientation: 'DIRECTED'});
  const infeasible = candidateTemplates([relationWithoutEvidence]);
  assert.equal(infeasible.status, 'INFEASIBLE');

  const identity = fieldRequirement('capability.identity', {stability_scope: 'TASK'});
  const candidates = candidateTemplates([identity]);
  assert.equal(candidates.status, 'CANDIDATES');
  assert.ok(candidates.candidates[0].templates.length >= 2);
  assert.notEqual(candidates.status, 'AMBIGUOUS');
});

test('Pareto filtering and canonical action serialization select a deterministic representation plan', () => {
  const identity = fieldRequirement('capability.identity', {stability_scope: 'TASK'});
  const selected = selectPlan([identity]);
  assert.equal(selected.status, 'FEASIBLE');
  assert.equal(selected.candidate_count, 2);
  assert.equal(selected.pareto_count, 1);
  assert.deepEqual(selected.selected_action_ids, ['action.field.stable_token']);

  const tieCatalog = clone(catalog);
  const alternate = clone(tieCatalog.templates.find((item) => item.template_id === 'template.field.stable_tokenization'));
  alternate.template_id = 'template.field.stable_tokenization_alt';
  alternate.canonical_action_template.action_id = 'action.field.stable_token_alt';
  tieCatalog.templates.push(alternate);
  const tie = selectPlan([identity], tieCatalog);
  assert.equal(tie.status, 'FEASIBLE');
  assert.equal(tie.pareto_count, 2);
  assert.deepEqual(tie.selected_action_ids, ['action.field.stable_token']);
});

test('frozen v0.1/v0.2/v0.2.1 planner artifacts are unchanged', () => {
  const frozen = [
    'fixtures/planner-capability-schema-v0.1.json',
    'fixtures/planner-capability-schema-v0.2.json',
    'fixtures/planner-capability-schema-v0.2.1.json',
    'fixtures/planner-representation-catalog-v0.2.json',
    'fixtures/planner-representation-catalog-v0.2.1.json',
    'fixtures/planner-seed-cases-v0.2.json',
    'fixtures/planner-seed-cases-v0.2.1.json',
    'fixtures/planner-negative-cases-v0.2.json',
    'fixtures/planner-negative-cases-v0.2.1.json',
    'tests/planner-spec.test.js',
    'tests/planner-spec-v0.2.test.js',
    'tests/planner-spec-v0.2.1.test.js',
    'src/planner-prototype-implementation.js'
  ];
  for (const relativePath of frozen) {
    const result = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', relativePath], {cwd: ROOT});
    assert.equal(result.status, 0, relativePath);
  }
});
