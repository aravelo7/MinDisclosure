'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures',
  'planner-capability-schema-v0.1.json'), 'utf8'));
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures',
  'planner-seed-cases-v0.1.json'), 'utf8'));
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures',
  'md-bench-v0.2.json'), 'utf8'));
const searchSpace = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures',
  'md-bench-v0.2-search-space.json'), 'utf8'));

const TASK_IDS = [
  'MD-EQ-01', 'MD-GROUP-02', 'MD-ORDER-03', 'MD-LOC-04',
  'MD-CROSS-05', 'MD-GRAPH-06', 'MD-TOOL-07'
];
const OPERATION_FAMILIES = new Set([
  'equality', 'deduplicate', 'group_by', 'aggregate', 'sort', 'filter',
  'compare', 'temporal_window', 'record_linkage', 'graph_relation',
  'degree', 'reachability', 'select', 'tool_call'
]);
const CAPABILITY_FAMILIES = new Set(['identity', 'property', 'relation', 'exact_value']);
const CAPABILITY_NAMES = new Set([
  'identity', 'equality', 'linkage', 'domain', 'category', 'ordering',
  'coarse_temporal', 'geographic_region', 'service_zone',
  'existing_relation', 'membership', 'directionality', 'temporal_comparison',
  'exact_value'
]);
const CAPABILITY_NAMES_BY_FAMILY = {
  identity: new Set(['identity', 'equality', 'linkage']),
  property: new Set(['domain', 'category', 'ordering', 'coarse_temporal', 'geographic_region', 'service_zone']),
  relation: new Set(['existing_relation', 'membership', 'directionality', 'temporal_comparison']),
  exact_value: new Set(['exact_value'])
};
const REPRESENTATION_LABELS = [
  'RAW_VALUE', 'COARSENED_VALUE', 'DERIVED_PROPERTY', 'RELATION_ONLY',
  'OPAQUE_TOKEN', 'REDACTED', 'FIXED_REDACTION', 'STABLE_TOKENIZATION',
  'ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'
];
const ANSWER_KEYS = [
  'ground_truth', 'answer', 'answer_equivalent', 'selected_entity',
  'selected_candidate', 'aggregate_result', 'matched_pair', 'degree_result',
  'reachability_result', 'final_recipient', 'restored_output', 'raw_value'
];

function assertOperation(operation) {
  assert.match(operation.operation_id, /^op\.[a-z][a-z0-9_.-]*$/);
  assert.ok(OPERATION_FAMILIES.has(operation.family), operation.family);
  assert.ok(['AGENT_REASONING', 'TOOL_EXECUTION'].includes(operation.role));
  assert.ok(operation.inputs.length > 0);
  for (const input of operation.inputs) {
    assert.match(input.field_ref, /^[a-z][a-z0-9_.\[\]-]*$/);
    assert.equal(typeof input.semantic_type, 'string');
  }
  assert.ok(operation.uses.length > 0);
  for (const use of operation.uses) {
    assert.ok(['property', 'relation', 'comparison', 'ordering', 'aggregation', 'selection'].includes(use.kind));
    assert.match(use.name, /^[a-z][a-z0-9_.-]*$/);
  }
  assert.ok(['groups', 'ordered_records', 'record_pairs', 'graph_summary',
    'aggregate_table', 'selected_record', 'tool_call', 'task_result'].includes(operation.result_shape));
}

function assertCapabilityRequirements(requirements) {
  assert.equal(requirements.capability_ir_version, 'information-capability-ir-v0.1');
  assert.ok(requirements.requirements.length > 0);
  const ids = new Set();
  for (const requirement of requirements.requirements) {
    assert.match(requirement.requirement_id, /^req\.[a-z][a-z0-9_.-]*$/);
    assert.equal(ids.has(requirement.requirement_id), false);
    ids.add(requirement.requirement_id);
    assert.ok(requirement.targets.length > 0);
    for (const target of requirement.targets) {
      assert.match(target.field_ref, /^[a-z][a-z0-9_.\[\]-]*$/);
      assert.equal(typeof target.semantic_type, 'string');
    }
    assert.ok(CAPABILITY_FAMILIES.has(requirement.capability.family));
    assert.ok(CAPABILITY_NAMES.has(requirement.capability.name));
    assert.ok(CAPABILITY_NAMES_BY_FAMILY[requirement.capability.family].has(requirement.capability.name));
    assert.ok(['AGENT', 'TOOL'].includes(requirement.boundary));
    assert.match(requirement.purpose, /^[a-z][a-z0-9_.-]*$/);
    assert.equal(typeof requirement.exact_value_required, 'boolean');
    assert.ok(['all_occurrences', 'all_records', 'declared_relation_set',
      'declared_tool_argument'].includes(requirement.scope));
    assert.ok(['USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA']
      .includes(requirement.authority));
    assert.notEqual(requirement.authority, 'UNTRUSTED_CONTENT');
  }
}

function assertTaskIr(taskIr) {
  assert.equal(taskIr.task_ir_version, 'task-ir-v0.1');
  assert.ok(taskIr.operations.length > 0);
  const operationIds = new Set();
  for (const operation of taskIr.operations) {
    assert.equal(operationIds.has(operation.operation_id), false);
    operationIds.add(operation.operation_id);
    assertOperation(operation);
  }
  for (const constraint of taskIr.presentation) {
    assert.match(constraint.constraint_id, /^presentation\.[a-z][a-z0-9_.-]*$/);
    assert.ok(['semantic_order', 'identifier_assignment', 'label_convention',
      'serialization_guard'].includes(constraint.kind));
    assert.ok(['USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA']
      .includes(constraint.authority));
    assert.match(constraint.rule, /^[a-z][a-z0-9_.-]*$/);
  }
}

function oracleDimension(taskId, dimensionId) {
  return searchSpace.tasks.find((task) => task.task_id === taskId)?.dimensions
    .find((dimension) => dimension.dimension_id === dimensionId);
}

function assertOracleBridge(seedCase) {
  const requirements = seedCase.gold_capability_requirements.requirements;
  const refs = seedCase.oracle_bridge.dimension_references;
  assert.equal(refs.length, requirements.length);
  const referencedRequirements = new Set();
  for (const reference of refs) {
    assert.equal(referencedRequirements.has(reference.requirement_id), false);
    referencedRequirements.add(reference.requirement_id);
    assert.ok(requirements.some((requirement) => requirement.requirement_id === reference.requirement_id));
    if (seedCase.task_id === 'MD-GRAPH-06' && reference.dimension_id === 'source_relations') {
      assert.equal(reference.selected_transform_id, 'RELATION_ONLY');
      continue;
    }
    const dimension = oracleDimension(seedCase.task_id, reference.dimension_id);
    assert.ok(dimension, `${seedCase.task_id}/${reference.dimension_id}`);
    assert.ok(dimension.chain.some((step) => step.transform_id === reference.selected_transform_id));
  }
}

test('planner schema is closed, versioned, and has global vocabularies', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema_version', 'task_ir', 'capability_requirements', 'uncertainty']);
  assert.equal(schema.properties.schema_version.const, 'planner-capability-schema-v0.1');
  assert.deepEqual(schema.properties.uncertainty.enum, ['CONFIDENT', 'UNCERTAIN', 'INVALID']);
  assert.ok(schema.$defs.task_ir);
  assert.ok(schema.$defs.capability_requirements);
  assert.deepEqual(new Set(schema.$defs.operation.properties.family.enum), OPERATION_FAMILIES);
  assert.deepEqual(new Set(schema.$defs.capability.properties.name.enum), CAPABILITY_NAMES);
  const schemaText = JSON.stringify(schema);
  for (const label of REPRESENTATION_LABELS) assert.equal(schemaText.includes(label), false, label);
});

test('all seven seed tasks have valid Task IR and Gold capability requirements', () => {
  assert.equal(seeds.schema_version, 'planner-capability-schema-v0.1');
  assert.equal(seeds.benchmark_version, 'md-bench-v0.2');
  assert.equal(seeds.cases.length, 7);
  assert.deepEqual(seeds.cases.map((item) => item.task_id), TASK_IDS);
  const ids = new Set();
  for (const seedCase of seeds.cases) {
    assert.equal(ids.has(seedCase.task_id), false);
    ids.add(seedCase.task_id);
    assertTaskIr(seedCase.task_ir);
    assertCapabilityRequirements(seedCase.gold_capability_requirements);
    assertOracleBridge(seedCase);
  }
});

test('seed fixture is raw-blind and contains no answer or solver result', () => {
  const seedText = JSON.stringify(seeds);
  for (const task of frozen.tasks) {
    for (const entity of task.sensitive_entities) {
      assert.equal(seedText.includes(entity.raw_value), false, entity.occurrence_id);
    }
  }
  for (const key of ANSWER_KEYS) assert.equal(seedText.includes(`"${key}"`), false, key);
  assert.equal(seedText.includes('ground truth'), false);
  assert.equal(seedText.includes('answer-equivalent'), false);
});

test('capabilities use only the global ontology and never encode presentation labels', () => {
  const seedText = seeds.cases.map((item) => JSON.stringify(item.gold_capability_requirements)).join('\n');
  for (const label of REPRESENTATION_LABELS) assert.equal(seedText.includes(label), false, label);
  for (const seedCase of seeds.cases) {
    const capabilityText = JSON.stringify(seedCase.gold_capability_requirements);
    assert.equal(capabilityText.includes('g1'), false);
    assert.equal(capabilityText.includes('g2'), false);
    assert.equal(capabilityText.includes('n1'), false);
    assert.equal(capabilityText.includes('json_key'), false);
  }
  const loc = seeds.cases.find((item) => item.task_id === 'MD-LOC-04');
  assert.ok(loc.task_ir.presentation.some((item) => item.rule === 'zone_rule_order'));
  assert.ok(loc.task_ir.presentation.some((item) => item.rule === 'not_json_key_order'));
  const graph = seeds.cases.find((item) => item.task_id === 'MD-GRAPH-06');
  assert.ok(graph.task_ir.presentation.some((item) => item.rule === 'first_endpoint_appearance'));
  assert.ok(graph.task_ir.presentation.every((item) => item.kind !== 'semantic_order' || item.rule !== 'json_key_order'));
});

test('Tool requirements and authority semantics are explicit', () => {
  const tool = seeds.cases.find((item) => item.task_id === 'MD-TOOL-07');
  const recipient = tool.gold_capability_requirements.requirements.find((item) => item.requirement_id === 'req.tool.recipient');
  const zone = tool.gold_capability_requirements.requirements.find((item) => item.requirement_id === 'req.tool.zone');
  assert.equal(recipient.boundary, 'TOOL');
  assert.equal(recipient.capability.name, 'exact_value');
  assert.equal(recipient.exact_value_required, true);
  assert.equal(recipient.authority, 'TOOL_SCHEMA');
  assert.equal(zone.boundary, 'AGENT');
  assert.equal(zone.capability.name, 'service_zone');
  assert.equal(zone.authority, 'TRUSTED_WORKFLOW');
});

test('seed capabilities are explainable by the frozen finite Oracle space', () => {
  for (const seedCase of seeds.cases) {
    assertOracleBridge(seedCase);
    for (const reference of seedCase.oracle_bridge.dimension_references) {
      if (reference.dimension_id === 'source_relations') continue;
      const dimension = oracleDimension(seedCase.task_id, reference.dimension_id);
      const selected = dimension.chain.find((step) => step.transform_id === reference.selected_transform_id);
      assert.ok(selected.representation);
    }
  }
});

test('Planner contract does not import implementation or frozen answer artifacts', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'planner-spec-v0.1.md'), 'utf8');
  assert.equal(text.includes('src/'), false);
  assert.equal(text.includes('ground_truth'), false);
  assert.equal(text.includes('first'), true);
  assert.equal(text.includes('global optimum'), true);
  const seedText = JSON.stringify(seeds);
  for (const forbidden of ['src/', 'oracle.js', 'solver.js', 'transformer.js', 'ground_truth']) {
    assert.equal(seedText.includes(forbidden), false, forbidden);
  }
});
