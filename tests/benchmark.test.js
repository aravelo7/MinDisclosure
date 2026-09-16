'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPRESENTATIONS,
  STRATEGIES,
  TASK_IDS,
  evaluateOutput,
  executeTask,
  loadFixture,
  runBenchmark,
  transformTask
} = require('../src/benchmark');

const fixture = loadFixture();

function taskById(taskId) {
  return fixture.tasks.find((task) => task.task_id === taskId);
}

function resultById(report, taskId, strategy) {
  return report.results.find((result) =>
    result.task_id === taskId && result.strategy === strategy);
}

test('fixture freezes exactly seven tasks and three strategies', () => {
  assert.deepEqual(fixture.tasks.map((task) => task.task_id), TASK_IDS);
  assert.deepEqual(fixture.strategies, STRATEGIES);
});

test('Stable Tokenization maps the same identity to the same neutral token', () => {
  const task = taskById('MD-EQ-01');
  const transformed = transformTask(fixture, task, 'STABLE_TOKENIZATION');
  const values = transformed.agent_input.records.map((record) => record.email);

  assert.equal(values[0], values[2]);
  assert.notEqual(values[0], values[1]);
  assert.notEqual(values[0], values[3]);
  assert.match(values[0], /^<E_\d{3}>$/);
  assert.equal(values[0].includes('EMAIL'), false);
});

test('Fixed Redaction never preserves equality across occurrences', () => {
  const task = taskById('MD-EQ-01');
  const transformed = transformTask(fixture, task, 'FIXED_REDACTION');
  const values = transformed.agent_input.records.map((record) => record.email);

  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every((value) => /^<REDACTED_\d{3}>$/.test(value)));
});

test('Task-aware input exposes no sensitive raw value and traces every non-redacted item to an allowlisted requirement', () => {
  for (const task of fixture.tasks) {
    const transformed = transformTask(fixture, task, 'TASK_AWARE');
    const serialized = JSON.stringify(transformed.agent_input);
    for (const entity of task.sensitive_entities) {
      assert.equal(
        serialized.includes(entity.raw_value),
        false,
        `${task.task_id} leaked ${entity.occurrence_id}`
      );
    }

    const requirements = new Map(task.task_requirements.map((item) => [item.requirement_id, item]));
    for (const entry of transformed.agent_ledger) {
      if (entry.representation === 'REDACTED') {
        assert.equal(entry.requirement_id, null);
        continue;
      }
      assert.ok(entry.requirement_id, `${task.task_id} has untraced disclosure`);
      const requirement = requirements.get(entry.requirement_id);
      assert.ok(requirement, `${task.task_id} uses an unknown requirement`);
      assert.ok(
        requirement.allowed_representations.includes(entry.representation),
        `${task.task_id} uses a representation outside the allowlist`
      );
    }
  }
});

test('Agent ledger counts and exposure weights match the frozen per-task plan', () => {
  for (const task of fixture.tasks) {
    for (const strategy of STRATEGIES) {
      const transformed = transformTask(fixture, task, strategy);
      const actualCounts = Object.fromEntries(REPRESENTATIONS.map((name) => [name, 0]));
      let expectedScore = 0;
      for (const entry of transformed.agent_ledger) {
        actualCounts[entry.representation] += 1;
        assert.equal(entry.exposure_weight, fixture.exposure_weights[entry.representation]);
        expectedScore += entry.exposure_weight;
      }
      const frozenCounts = task.expected_agent_ledger_counts[strategy];
      for (const representation of REPRESENTATIONS) {
        assert.equal(
          actualCounts[representation],
          frozenCounts[representation] ?? 0,
          `${task.task_id}/${strategy}/${representation}`
        );
      }
      const report = runBenchmark();
      const result = resultById(report, task.task_id, strategy);
      assert.equal(result.exposure.agent.exposure_score, expectedScore);
      assert.equal(result.exposure.agent.raw_exposure_count, 0);
    }
  }
});

test('all 21 deterministic combinations have the expected utility outcomes', () => {
  const report = runBenchmark();
  assert.equal(report.total_combinations, 21);

  const expectedSuccess = {
    'MD-EQ-01': ['STABLE_TOKENIZATION', 'TASK_AWARE'],
    'MD-GROUP-02': ['TASK_AWARE'],
    'MD-ORDER-03': ['TASK_AWARE'],
    'MD-LOC-04': ['TASK_AWARE'],
    'MD-CROSS-05': ['TASK_AWARE'],
    'MD-GRAPH-06': ['STABLE_TOKENIZATION', 'TASK_AWARE'],
    'MD-TOOL-07': ['TASK_AWARE']
  };

  for (const result of report.results) {
    assert.equal(
      result.task_success,
      expectedSuccess[result.task_id].includes(result.strategy),
      `${result.task_id}/${result.strategy}`
    );
    assert.equal(result.validity, 'valid');
  }
});

test('Stable Tokenization succeeds on both frozen control tasks', () => {
  const report = runBenchmark();
  assert.equal(resultById(report, 'MD-EQ-01', 'STABLE_TOKENIZATION').task_success, true);
  assert.equal(resultById(report, 'MD-GRAPH-06', 'STABLE_TOKENIZATION').task_success, true);
});

test('each of the seven task oracles accepts its Task-aware deterministic output', () => {
  for (const task of fixture.tasks) {
    const transformed = transformTask(fixture, task, 'TASK_AWARE');
    const output = executeTask(task, transformed);
    const evaluated = evaluateOutput(fixture, task, output, transformed);
    assert.equal(evaluated.task_success, true, task.task_id);
    assert.ok(Object.values(evaluated.relationship_checks).every(Boolean), task.task_id);
  }
});

test('tool restoration is task-local, exact, and boundary-accounted', () => {
  const report = runBenchmark();
  const stable = resultById(report, 'MD-TOOL-07', 'STABLE_TOKENIZATION');
  const taskAware = resultById(report, 'MD-TOOL-07', 'TASK_AWARE');
  const fixed = resultById(report, 'MD-TOOL-07', 'FIXED_REDACTION');

  for (const result of [stable, taskAware]) {
    assert.equal(result.restore_correctness.applicable, true);
    assert.equal(result.restore_correctness.restored_items, 1);
    assert.equal(result.restore_correctness.correctly_restored_items, 1);
    assert.equal(result.restore_correctness.unknown_token_count, 0);
    assert.equal(result.restore_correctness.accidental_raw_output_count, 0);
    assert.equal(result.exposure.tool.category_counts.RAW_VALUE, 1);
    assert.equal(result.exposure.tool.exposure_score, 1);
  }
  assert.equal(fixed.restore_correctness.applicable, false);
  assert.equal(fixed.exposure.tool.exposure_score, 0);
  assert.equal(taskAware.restored_output.arguments.recipient, 'omar.khan@example.com');
});

test('accidental raw output in a tokenized tool arm is counted and rejected', () => {
  const task = taskById('MD-TOOL-07');
  const transformed = transformTask(fixture, task, 'STABLE_TOKENIZATION');
  const output = {
    tool: 'dispatch_visit',
    arguments: {
      ticket_id: 't2',
      recipient: 'omar.khan@example.com',
      service_zone: 'EAST'
    }
  };
  const evaluated = evaluateOutput(fixture, task, output, transformed);
  assert.equal(evaluated.restore_correctness.accidental_raw_output_count, 1);
  assert.equal(evaluated.task_success, false);
});

test('malformed output is schema-invalid for every task oracle', () => {
  for (const task of fixture.tasks) {
    const transformed = transformTask(fixture, task, 'STABLE_TOKENIZATION');
    const evaluated = evaluateOutput(fixture, task, '{not valid json', transformed);
    assert.equal(evaluated.task_success, false, task.task_id);
    assert.equal(evaluated.validity, 'schema_invalid', task.task_id);
  }
});

test('closed output schemas reject extra fields', () => {
  const task = taskById('MD-EQ-01');
  const transformed = transformTask(fixture, task, 'STABLE_TOKENIZATION');
  const evaluated = evaluateOutput(fixture, task, {
    duplicate_groups: [['r1', 'r3']],
    explanation: 'extra'
  }, transformed);
  assert.equal(evaluated.task_success, false);
  assert.equal(evaluated.validity, 'schema_invalid');
});
