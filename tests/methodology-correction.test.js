'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {loadFixture, runBenchmark} = require('../src/md-bench-v0.2');
const {evaluateOutput, projectOracleCase} = require('../src/oracle');
const {loadSearchSpace, searchAllOraclePlans} = require('../src/oracle-search');
const {projectTransformationCase, transformTask} = require('../src/transformer');

const fixture = loadFixture();
const fixtureMeta = {exposure_weights: fixture.exposure_weights};

function taskById(taskId) {
  return fixture.tasks.find((task) => task.task_id === taskId);
}

function resultById(report, taskId, strategy) {
  return report.results.find((result) => result.task_id === taskId && result.strategy === strategy);
}

test('search space is finite, privacy ordered, task-specific, and contains no answer transforms', () => {
  const searchSpace = loadSearchSpace();
  assert.equal(searchSpace.tasks.length, 7);
  const prohibited = new Set([
    'RANK', 'SORTED_POSITION', 'DUPLICATE_GROUP', 'MATCHING_PAIR', 'WITHIN_72H_PAIR',
    'ARGMAX', 'ARGMIN', 'AGGREGATE_RESULT', 'SELECTED_TICKET', 'FINAL_RECIPIENT',
    'REACHABILITY_RESULT', 'DEGREE_RESULT'
  ]);
  for (const task of searchSpace.tasks) {
    assert.ok(task.dimensions.length >= 1 && task.dimensions.length <= 2);
    for (const dimension of task.dimensions) {
      assert.equal(dimension.chain[0].transform_id, 'REDACT');
      assert.equal(dimension.chain.at(-1).transform_id, 'RAW_VALUE');
      assert.ok(dimension.chain.every((option) => !prohibited.has(option.transform_id)));
      assert.ok(dimension.occurrence_ids.length > 0);
    }
  }
  assert.equal(JSON.stringify(searchSpace).includes('CITY'), false);
});

test('search-derived plans are component-wise minimal and match all frozen gold plans', () => {
  const results = searchAllOraclePlans(fixture);
  const expectedSelections = {
    'MD-EQ-01': ['STABLE_TOKEN'],
    'MD-GROUP-02': ['DOMAIN_HANDLE'],
    'MD-ORDER-03': ['BIRTH_YEAR'],
    'MD-LOC-04': ['SERVICE_ZONE'],
    'MD-CROSS-05': ['STABLE_TOKEN', 'HOUR_BUCKET'],
    'MD-GRAPH-06': ['STABLE_TOKEN'],
    'MD-TOOL-07': ['STABLE_TOKEN', 'SERVICE_ZONE']
  };
  for (const result of results) {
    assert.equal(result.objective, 'component_wise_privacy_order');
    assert.equal(result.minimal_feasible_plan_count, 1, result.task_id);
    assert.equal(result.gold_plan_matches_selected, true, result.task_id);
    assert.deepEqual(result.selected_selections.map((item) => item.transform_id), expectedSelections[result.task_id]);
    assert.ok(result.feasible_count >= 1);
  }
});

test('field-level search applies one chain choice uniformly to all occurrences in a dimension', () => {
  const searchSpace = loadSearchSpace();
  const results = searchAllOraclePlans(fixture);
  for (const result of results) {
    const searchTask = searchSpace.tasks.find((task) => task.task_id === result.task_id);
    const selected = result.minimal_feasible_plans[0];
    for (const dimension of searchTask.dimensions) {
      const occurrenceSet = new Set(dimension.occurrence_ids);
      const actions = selected.actions.filter((action) => occurrenceSet.has(action.occurrence_id));
      assert.equal(actions.length, dimension.occurrence_ids.length);
      assert.equal(new Set(actions.map((action) => action.representation)).size, 1);
    }
  }
});

test('Stable Tokenization preserves source relation structure without deriving new relations', () => {
  const task = taskById('MD-GRAPH-06');
  const transformed = transformTask(fixtureMeta, projectTransformationCase(task), 'STABLE_TOKENIZATION');
  assert.equal(transformed.agent_input.edges.length, task.raw_input.edges.length);
  assert.deepEqual(transformed.agent_input.edges.map((edge) => edge.edge_id), ['g1', 'g2', 'g3']);
  assert.equal(transformed.agent_ledger.filter((item) => item.representation === 'RELATION_ONLY').length, 3);
  assert.equal(transformed.agent_ledger.some((item) => ['degree', 'reachability'].includes(item.disclosed_name)), false);
});

test('Stable strong controls remain successful under search-derived Oracle execution', () => {
  const report = runBenchmark();
  for (const taskId of ['MD-EQ-01', 'MD-GRAPH-06']) {
    assert.equal(resultById(report, taskId, 'STABLE_TOKENIZATION').task_success, true);
    assert.equal(resultById(report, taskId, 'ORACLE_MIN_DISCLOSURE').task_success, true);
  }
});

test('failed Stable tool call remains invoked, valid, incorrect, and fully exposure-accounted', () => {
  const report = runBenchmark();
  const stable = resultById(report, 'MD-TOOL-07', 'STABLE_TOKENIZATION');
  assert.equal(stable.task_success, false);
  assert.deepEqual(stable.tool_status, {
    tool_invoked: true,
    tool_call_valid: true,
    tool_call_correct: false
  });
  assert.equal(stable.exposure.agent.exposure_score, 0.6);
  assert.equal(stable.exposure.tool.exposure_score, 1);
  assert.equal(stable.exposure.tool.category_counts.RAW_VALUE, 1);
  assert.equal(stable.exposure.ledger.some((item) =>
    item.boundary === 'TOOL' && item.disclosed_value === 'omar.khan@example.com'), true);
});

test('an invoked incorrect call that sends a raw recipient still records Tool exposure', () => {
  const task = taskById('MD-TOOL-07');
  const transformed = transformTask(fixtureMeta, projectTransformationCase(task), 'STABLE_TOKENIZATION');
  const evaluated = evaluateOutput(fixtureMeta, projectOracleCase(task), {
    tool: 'dispatch_visit',
    arguments: {ticket_id: 't2', recipient: 'mei.lin@example.com', service_zone: 'UNKNOWN'}
  }, transformed);
  assert.equal(evaluated.task_success, false);
  assert.deepEqual(evaluated.tool_status, {
    tool_invoked: true,
    tool_call_valid: true,
    tool_call_correct: false
  });
  assert.equal(evaluated.restore_correctness.accidental_raw_output_count, 1);
  assert.equal(evaluated.tool_ledger.length, 1);
  assert.equal(evaluated.tool_ledger[0].representation, 'RAW_VALUE');
  assert.equal(evaluated.tool_ledger[0].disclosed_value, 'mei.lin@example.com');
});

test('28-combination utility matrix remains unchanged and includes search evidence', () => {
  const report = runBenchmark();
  assert.equal(report.total_combinations, 28);
  assert.equal(report.oracle_search.length, 7);
  assert.equal(report.oracle_search_objective, 'component_wise_privacy_order_not_weighted_exposure');
  assert.deepEqual(Object.fromEntries(Object.entries(report.strategy_summary).map(([strategy, summary]) =>
    [strategy, summary.successful_tasks])), {
    FIXED_REDACTION: 0,
    STABLE_TOKENIZATION: 2,
    ORACLE_MIN_DISCLOSURE: 7,
    RAW_DISCLOSURE: 7
  });
});
