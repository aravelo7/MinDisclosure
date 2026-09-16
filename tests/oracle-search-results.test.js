'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {loadFixture} = require('../src/md-bench-v0.2');
const {searchAllOraclePlans} = require('../src/oracle-search');

test('frozen search-space candidate and feasible counts are reproducible', () => {
  const expected = {
    'MD-EQ-01': [3, 2],
    'MD-GROUP-02': [4, 2],
    'MD-ORDER-03': [4, 2],
    'MD-LOC-04': [4, 2],
    'MD-CROSS-05': [12, 4],
    'MD-GRAPH-06': [3, 2],
    'MD-TOOL-07': [12, 4]
  };
  for (const result of searchAllOraclePlans(loadFixture())) {
    assert.deepEqual([result.candidate_count, result.feasible_count], expected[result.task_id]);
    assert.equal(result.minimal_feasible_plan_count, 1);
    assert.equal(result.gold_plan_matches_selected, true);
  }
});
