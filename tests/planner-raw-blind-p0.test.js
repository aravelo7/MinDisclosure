'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const planner = require('../src/planner-prototype-implementation');

const ROOT = path.resolve(__dirname, '..');
const V03_SCHEMA_PATH = path.join(ROOT, 'fixtures', 'planner-capability-schema-v0.3.json');
const FORBIDDEN_KEYS = new Set([
  'raw_input',
  'raw_value',
  'sensitive_entities',
  'token_to_raw',
  'token_to_occurrences',
  'restored_output',
  'restoration_map',
  'oracle_disclosure_plan',
  'ground_truth',
  'oracle_bridge',
  'agent_ledger',
  'tool_ledger'
]);
const CANARIES = Object.freeze([
  'CANARY_EMAIL__p0_7f91@example.invalid',
  'CANARY_ADDRESS__P0__DO_NOT_LEAK',
  'CANARY_RAW_SECRET__9f31c7'
]);

function collectKeys(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, result));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      result.push(key);
      collectKeys(child, result);
    });
  }
  return result;
}

function collectReachableSchemaKeys(schema) {
  const result = [];
  const visited = new Set();

  function resolveLocalRef(ref) {
    assert.match(ref, /^#\//);
    return ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((value, part) => value?.[part], schema);
  }

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (typeof value.$ref === 'string') {
      const target = resolveLocalRef(value.$ref);
      assert.notEqual(target, undefined, value.$ref);
      visit(target);
    }

    Object.entries(value).forEach(([key, child]) => {
      result.push(key);
      if (key !== '$defs') visit(child);
    });
  }

  visit(schema);
  return result;
}

function forbiddenKeys(value) {
  return [...new Set(collectKeys(value).filter((key) => FORBIDDEN_KEYS.has(key)))].sort();
}

function containsCanary(value) {
  const serialized = planner.canonicalJson(value);
  return CANARIES.filter((canary) => serialized.includes(canary));
}

function requestBytes(request) {
  return Buffer.from(planner.canonicalJson(request), 'utf8');
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assetsWithLocalOnlyRawValues(assets) {
  const localAssets = planner.clone(assets);
  localAssets.dev.cases.forEach((item, index) => {
    item.raw_input = {
      email: CANARIES[0],
      address: CANARIES[1],
      secret: CANARIES[2]
    };
    item.sensitive_entities = [{entity_type: 'EMAIL', raw_value: CANARIES[0]}];
    item.token_to_raw = {TOKEN_001: CANARIES[0]};
    item.token_to_occurrences = {TOKEN_001: [{record_index: index, field_ref: 'records.email'}]};
    item.restored_output = {records: [{email: CANARIES[0], address: CANARIES[1]}]};
    item.restoration_map = {TOKEN_001: CANARIES[0]};
    item.oracle_disclosure_plan = {representation: 'RAW'};
    item.ground_truth = {raw_value: CANARIES[2]};
    item.oracle_bridge = {restoration_map: {TOKEN_001: CANARIES[0]}};
    item.agent_ledger = [{raw_input: CANARIES[0]}];
    item.tool_ledger = [{restored_output: CANARIES[1]}];
  });
  return localAssets;
}

test('current seven planner-visible fixtures contain no raw instance values', () => {
  const assets = planner.loadPlannerAssets();

  assert.equal(assets.dev.contains_raw_sensitive_values, false);
  assert.equal(assets.dev.cases.length, 7);

  const projection = planner.buildProviderVisibleProjection(assets.dev);
  assert.equal(projection.length, 7);
  projection.forEach((plannerInput) => {
    assert.deepEqual(forbiddenKeys(plannerInput), []);
    assert.deepEqual(containsCanary(plannerInput), []);
  });
});

test('forbidden local-only raw fields cannot enter projection or provider request', () => {
  const localAssets = assetsWithLocalOnlyRawValues(planner.loadPlannerAssets());
  const projection = planner.buildProviderVisibleProjection(localAssets.dev);

  assert.equal(projection.length, 7);
  projection.forEach((plannerInput) => {
    assert.deepEqual(forbiddenKeys(plannerInput), []);
    assert.deepEqual(containsCanary(plannerInput), []);
    assert.equal(planner.validatePlannerInput(plannerInput, localAssets).valid, true);
  });

  for (let caseIndex = 0; caseIndex < 7; caseIndex += 1) {
    const prepared = planner.preparePlannerRun({caseIndex, assets: localAssets});
    const bytes = requestBytes(prepared.request);

    assert.deepEqual(forbiddenKeys(prepared.plannerInput), []);
    assert.deepEqual(forbiddenKeys(prepared.request), []);
    for (const canary of CANARIES) {
      assert.equal(bytes.includes(Buffer.from(canary, 'utf8')), false, `${canary} leaked in case ${caseIndex + 1}`);
    }
    assert.equal(bytes.includes(Buffer.from('"restoration_map"', 'utf8')), false);
  }
});

test('v0.3 Planner-visible schema graph has no raw/restoration/evaluator/representation action fields', () => {
  const schema = JSON.parse(fs.readFileSync(V03_SCHEMA_PATH, 'utf8'));
  assert.equal(Object.hasOwn(schema.properties, 'evaluator_result'), false);
  assert.equal(Object.hasOwn(schema.$defs, 'evaluator_result'), true);

  const structuralViolations = [...new Set(collectReachableSchemaKeys(schema).filter((key) =>
    FORBIDDEN_KEYS.has(key) ||
    /^(?:raw(?:_|$)|restor(?:ation|ed)(?:_|$)|oracle(?:_|$)|evaluator(?:_|$)|representation(?:_|$)|action(?:_|$))/i.test(key)
  ))].sort();

  assert.deepEqual(structuralViolations, []);
});

test('instruction content is trusted semantic input and is not a PII sanitizer', () => {
  const localAssets = planner.clone(planner.loadPlannerAssets());
  const instructionCanary = CANARIES[0];
  localAssets.dev.cases[0].planner_input.task.instruction =
    `${localAssets.dev.cases[0].planner_input.task.instruction} ${instructionCanary}`;

  const prepared = planner.preparePlannerRun({caseIndex: 0, assets: localAssets});
  const bytes = requestBytes(prepared.request);

  assert.match(bytes.toString('utf8'), new RegExp(escapedRegExp(instructionCanary)));
  assert.equal(prepared.plannerInput.task.instruction.includes(instructionCanary), true);
});
