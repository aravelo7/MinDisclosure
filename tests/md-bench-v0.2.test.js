'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {REPRESENTATIONS, STRATEGIES, TASK_IDS, loadFixture, runBenchmark} = require('../src/md-bench-v0.2');
const {evaluateOutput, projectOracleCase} = require('../src/oracle');
const {projectSolverCase, solveTask} = require('../src/solver');
const {TRANSFORMER_INPUT_KEYS, projectTransformationCase, transformTask} = require('../src/transformer');

const fixture = loadFixture();
const fixtureMeta = {exposure_weights: fixture.exposure_weights};

function taskById(taskId) {
  return fixture.tasks.find((task) => task.task_id === taskId);
}

function transformed(taskId, strategy = 'ORACLE_MIN_DISCLOSURE') {
  return transformTask(fixtureMeta, projectTransformationCase(taskById(taskId)), strategy);
}

function resultById(report, taskId, strategy) {
  return report.results.find((result) => result.task_id === taskId && result.strategy === strategy);
}

test('v0.2 freezes seven tasks and four baselines', () => {
  assert.deepEqual(fixture.tasks.map((task) => task.task_id), TASK_IDS);
  assert.deepEqual(fixture.strategies, STRATEGIES);
});

test('transformer projection structurally excludes solver and oracle data', () => {
  for (const task of fixture.tasks) {
    const projected = projectTransformationCase(task);
    assert.deepEqual(Object.keys(projected), TRANSFORMER_INPUT_KEYS);
    assert.equal(Object.hasOwn(projected, 'ground_truth'), false);
    assert.equal(Object.hasOwn(projected, 'oracle'), false);
    assert.equal(Object.hasOwn(projected, 'expected_output_schema'), false);
    assert.equal(Object.hasOwn(projected, 'user_instruction'), false);
  }
  const dependencies = require.cache[require.resolve('../src/transformer')].children.map((module) => module.filename);
  assert.equal(dependencies.some((name) => name.endsWith('solver.js') || name.endsWith('oracle.js')), false);
});

test('solver receives only transformed input and task instruction', () => {
  const task = taskById('MD-ORDER-03');
  const solverCase = projectSolverCase(task, transformed(task.task_id));
  assert.deepEqual(Object.keys(solverCase), ['task_id', 'user_instruction', 'agent_input']);
  assert.equal(Object.hasOwn(solverCase, 'ground_truth'), false);
  assert.equal(Object.hasOwn(solverCase, 'task_requirements'), false);
});

test('Stable Tokenization preserves identity and Fixed Redaction does not', () => {
  const stable = transformed('MD-EQ-01', 'STABLE_TOKENIZATION').agent_input.records.map((record) => record.email);
  const fixed = transformed('MD-EQ-01', 'FIXED_REDACTION').agent_input.records.map((record) => record.email);
  assert.equal(stable[0], stable[2]);
  assert.notEqual(stable[0], stable[1]);
  assert.equal(new Set(fixed).size, 4);
});

test('Oracle disclosures contain no raw sensitive values and every item is allowlisted', () => {
  for (const task of fixture.tasks) {
    const output = transformed(task.task_id);
    const serialized = JSON.stringify(output.agent_input);
    for (const entity of task.sensitive_entities) {
      assert.equal(serialized.includes(entity.raw_value), false, `${task.task_id}/${entity.occurrence_id}`);
    }
    const requirements = new Map(task.task_requirements.map((item) => [item.requirement_id, item]));
    for (const item of output.agent_ledger) {
      const requirement = requirements.get(item.requirement_id);
      assert.ok(requirement, `${task.task_id}/${item.disclosed_name}`);
      assert.ok(requirement.allowed_representations.includes(item.representation));
    }
  }
});

test('No-Solver task structures retain records and omit precomputed answers', () => {
  const group = transformed('MD-GROUP-02').agent_input;
  assert.equal(group.invoices.length, 4);
  assert.ok(group.invoices.every((item) => Object.keys(item).sort().join(',') === 'amount,contact_email,invoice_id'));

  const order = transformed('MD-ORDER-03').agent_input;
  assert.deepEqual(order.people.map((person) => person.date_of_birth), [1994, 1981, 2000, 1988]);

  const cross = transformed('MD-CROSS-05').agent_input;
  assert.equal(cross.events.length, 5);
  assert.ok(cross.events.every((item) => Object.keys(item).sort().join(',') === 'event_id,subject_email,timestamp'));

  const graph = transformed('MD-GRAPH-06').agent_input;
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.edges.every((edge) => Object.keys(edge).sort().join(',') === 'edge_id,from,to'));

  const tool = transformed('MD-TOOL-07').agent_input;
  assert.deepEqual(tool.tickets.map((ticket) => ticket.ticket_id), ['t1', 't2', 't3']);
  assert.ok(tool.tickets.every((ticket) => !Object.hasOwn(ticket, 'selected')));
});

test('Oracle disclosure plans contain only occurrence-local operations', () => {
  const permittedActionKeys = new Set(['occurrence_id', 'representation', 'property_name', 'reversible', 'requirement_id']);
  for (const task of fixture.tasks) {
    for (const action of task.oracle_disclosure_plan.actions) {
      assert.ok(Object.keys(action).every((key) => permittedActionKeys.has(key)), `${task.task_id}/${JSON.stringify(action)}`);
      assert.equal(Array.isArray(action.occurrence_id), false);
    }
  }
});

test('ledger category counts and exposure weights match the frozen fixture', () => {
  for (const task of fixture.tasks) {
    for (const strategy of STRATEGIES) {
      const output = transformed(task.task_id, strategy);
      const counts = Object.fromEntries(REPRESENTATIONS.map((name) => [name, 0]));
      for (const item of output.agent_ledger) {
        counts[item.representation] += 1;
        assert.equal(item.exposure_weight, fixture.exposure_weights[item.representation]);
      }
      for (const representation of REPRESENTATIONS) {
        assert.equal(counts[representation], task.expected_agent_ledger_counts[strategy][representation] ?? 0,
          `${task.task_id}/${strategy}/${representation}`);
      }
    }
  }
});

test('all 28 deterministic combinations follow the expected sanity pattern', () => {
  const report = runBenchmark();
  assert.equal(report.total_combinations, 28);
  const expected = {
    'MD-EQ-01': ['STABLE_TOKENIZATION', 'ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-GROUP-02': ['ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-ORDER-03': ['ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-LOC-04': ['ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-CROSS-05': ['ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-GRAPH-06': ['STABLE_TOKENIZATION', 'ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE'],
    'MD-TOOL-07': ['ORACLE_MIN_DISCLOSURE', 'RAW_DISCLOSURE']
  };
  for (const result of report.results) {
    assert.equal(result.task_success, expected[result.task_id].includes(result.strategy), `${result.task_id}/${result.strategy}`);
    assert.equal(result.validity, 'valid');
  }
});

test('reference solver validates every task without raw fixture or gold inputs', () => {
  for (const task of fixture.tasks) {
    const output = transformed(task.task_id);
    const candidate = solveTask(projectSolverCase(task, output));
    const evaluated = evaluateOutput(fixtureMeta, projectOracleCase(task), candidate, output);
    assert.equal(evaluated.task_success, true, task.task_id);
    assert.ok(Object.values(evaluated.relationship_checks).every(Boolean), task.task_id);
  }
});

test('tool transformation keeps every candidate and restores only the selected recipient', () => {
  const report = runBenchmark();
  const oracle = resultById(report, 'MD-TOOL-07', 'ORACLE_MIN_DISCLOSURE');
  assert.equal(oracle.agent_input.tickets.length, 3);
  assert.equal(oracle.restore_correctness.applicable, true);
  assert.equal(oracle.restore_correctness.restored_items, 1);
  assert.equal(oracle.restore_correctness.correctly_restored_items, 1);
  assert.equal(oracle.exposure.tool.category_counts.RAW_VALUE, 1);
  assert.equal(oracle.restored_output.arguments.recipient, 'omar.khan@example.com');
});

test('malformed and extra-field outputs fail every oracle', () => {
  for (const task of fixture.tasks) {
    const output = transformed(task.task_id);
    const malformed = evaluateOutput(fixtureMeta, projectOracleCase(task), null, output);
    assert.equal(malformed.task_success, false, task.task_id);
    assert.equal(malformed.validity, 'schema_invalid', task.task_id);
  }
  const task = taskById('MD-EQ-01');
  const output = transformed(task.task_id);
  const extra = evaluateOutput(fixtureMeta, projectOracleCase(task), {duplicate_groups: [['r1', 'r3']], answer: true}, output);
  assert.equal(extra.task_success, false);
});

test('Oracle raw-value reduction is explicit and normalized exposure uses Raw as denominator', () => {
  const report = runBenchmark();
  for (const taskId of TASK_IDS) {
    const oracle = resultById(report, taskId, 'ORACLE_MIN_DISCLOSURE');
    const raw = resultById(report, taskId, 'RAW_DISCLOSURE');
    assert.equal(oracle.exposure.oracle_relative_raw_value_reduction, 1);
    assert.equal(raw.exposure.normalized_exposure, 1);
    assert.equal(oracle.exposure.normalized_exposure, oracle.exposure.agent.exposure_score / raw.exposure.agent.exposure_score);
  }
});
