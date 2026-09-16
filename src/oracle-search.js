'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {evaluateOutput, projectOracleCase} = require('./oracle');
const {projectSolverCase, solveTask} = require('./solver');
const {projectTransformationCase, transformTask} = require('./transformer');

const DEFAULT_SEARCH_SPACE_PATH = path.resolve(__dirname, '..', 'fixtures', 'md-bench-v0.2-search-space.json');

function loadSearchSpace(searchSpacePath = DEFAULT_SEARCH_SPACE_PATH) {
  return JSON.parse(fs.readFileSync(searchSpacePath, 'utf8'));
}

function enumerateVectors(dimensions) {
  const vectors = [];
  function visit(prefix, index) {
    if (index === dimensions.length) {
      vectors.push(prefix);
      return;
    }
    for (let level = 0; level < dimensions[index].chain.length; level += 1) {
      visit([...prefix, level], index + 1);
    }
  }
  visit([], 0);
  return vectors;
}

function planForVector(searchTask, vector) {
  const actions = [];
  const selections = [];
  searchTask.dimensions.forEach((dimension, dimensionIndex) => {
    const option = dimension.chain[vector[dimensionIndex]];
    selections.push({
      dimension_id: dimension.dimension_id,
      level: vector[dimensionIndex],
      transform_id: option.transform_id
    });
    for (const occurrenceId of dimension.occurrence_ids) {
      actions.push({
        occurrence_id: occurrenceId,
        representation: option.representation,
        ...(option.property_name ? {property_name: option.property_name} : {}),
        ...(option.reversible ? {reversible: true} : {}),
        requirement_id: dimension.requirement_id
      });
    }
  });
  return {actions, selections};
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

function canonicalPlan(plan) {
  return JSON.stringify(plan.actions
    .map((action) => ({
      occurrence_id: action.occurrence_id,
      representation: action.representation,
      property_name: action.property_name ?? null,
      reversible: Boolean(action.reversible),
      requirement_id: action.requirement_id
    }))
    .sort((left, right) => left.occurrence_id.localeCompare(right.occurrence_id)));
}

function searchOraclePlan(fixture, task, searchTask) {
  if (task.task_id !== searchTask.task_id) throw new Error('search/task mismatch');
  const fixtureMeta = {exposure_weights: fixture.exposure_weights};
  const candidates = [];

  for (const vector of enumerateVectors(searchTask.dimensions)) {
    const candidatePlan = planForVector(searchTask, vector);
    const transformed = transformTask(
      fixtureMeta,
      projectTransformationCase(task, {actions: candidatePlan.actions}),
      'ORACLE_MIN_DISCLOSURE'
    );
    const candidateOutput = solveTask(projectSolverCase(task, transformed));
    const evaluated = evaluateOutput(fixtureMeta, projectOracleCase(task), candidateOutput, transformed);
    candidates.push({
      vector,
      plan: candidatePlan,
      task_success: evaluated.task_success
    });
  }

  const feasible = candidates.filter((candidate) => candidate.task_success);
  const minimal = feasible.filter((candidate) =>
    !feasible.some((other) => dominates(other.vector, candidate.vector))
  ).sort((left, right) => compareVectors(left.vector, right.vector) ||
    canonicalPlan(left.plan).localeCompare(canonicalPlan(right.plan)));

  if (minimal.length === 0) throw new Error(`${task.task_id}: no feasible disclosure plan`);
  const selected = minimal[0];
  return {
    task_id: task.task_id,
    objective: 'component_wise_privacy_order',
    candidate_count: candidates.length,
    feasible_count: feasible.length,
    minimal_feasible_plan_count: minimal.length,
    tie_break_rule: 'lexicographically smallest level vector in frozen dimension order, then canonical action JSON',
    minimal_feasible_plans: minimal.map((candidate) => ({
      vector: candidate.vector,
      selections: candidate.plan.selections,
      actions: candidate.plan.actions
    })),
    selected_vector: selected.vector,
    selected_selections: selected.plan.selections,
    selected_plan: {actions: selected.plan.actions},
    gold_plan_matches_selected: canonicalPlan(task.oracle_disclosure_plan) === canonicalPlan(selected.plan)
  };
}

function searchAllOraclePlans(fixture, searchSpace = loadSearchSpace()) {
  const searchTasks = new Map(searchSpace.tasks.map((task) => [task.task_id, task]));
  return fixture.tasks.map((task) => searchOraclePlan(fixture, task, searchTasks.get(task.task_id)));
}

module.exports = {
  DEFAULT_SEARCH_SPACE_PATH,
  canonicalPlan,
  dominates,
  enumerateVectors,
  loadSearchSpace,
  planForVector,
  searchAllOraclePlans,
  searchOraclePlan
};
