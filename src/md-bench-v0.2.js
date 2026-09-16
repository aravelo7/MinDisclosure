'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {REPRESENTATIONS, STRATEGIES, TASK_IDS} = require('./constants');
const {evaluateOutput, projectOracleCase} = require('./oracle');
const {loadSearchSpace, searchAllOraclePlans, searchOraclePlan} = require('./oracle-search');
const {projectSolverCase, solveTask} = require('./solver');
const {emptyCategoryCounts, projectTransformationCase, transformTask} = require('./transformer');

const DEFAULT_FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'md-bench-v0.2.json');

function loadFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.benchmark_version !== 'md-bench-v0.2') throw new Error('unexpected benchmark version');
  if (JSON.stringify(fixture.strategies) !== JSON.stringify(STRATEGIES)) throw new Error('strategy contract mismatch');
  if (JSON.stringify(fixture.tasks.map((task) => task.task_id)) !== JSON.stringify(TASK_IDS)) throw new Error('task contract mismatch');
  return fixture;
}

function summarizeBoundary(ledger, boundary) {
  const items = ledger.filter((entry) => entry.boundary === boundary);
  const categoryCounts = emptyCategoryCounts();
  for (const item of items) categoryCounts[item.representation] += 1;
  const rawItems = items.filter((entry) => entry.representation === 'RAW_VALUE');
  return {
    category_counts: categoryCounts,
    raw_exposure_count: rawItems.length,
    raw_distinct_count: new Set(rawItems.map((entry) => JSON.stringify(entry.disclosed_value))).size,
    exposure_score: items.reduce((sum, entry) => sum + entry.exposure_weight, 0)
  };
}

function runTaskStrategy(fixture, task, strategy, oracleSearch = null) {
  const fixtureMeta = {exposure_weights: fixture.exposure_weights};
  let disclosurePlan = task.oracle_disclosure_plan;
  if (strategy === 'ORACLE_MIN_DISCLOSURE') {
    if (!oracleSearch) {
      const searchTask = loadSearchSpace().tasks.find((item) => item.task_id === task.task_id);
      oracleSearch = searchOraclePlan(fixture, task, searchTask);
    }
    disclosurePlan = oracleSearch.selected_plan;
  }
  const transformed = transformTask(
    fixtureMeta,
    projectTransformationCase(task, disclosurePlan),
    strategy
  );
  const candidateOutput = solveTask(projectSolverCase(task, transformed));
  const evaluated = evaluateOutput(fixtureMeta, projectOracleCase(task), candidateOutput, transformed);
  const ledger = [...transformed.agent_ledger, ...evaluated.tool_ledger];
  const agent = summarizeBoundary(ledger, 'AGENT');
  const tool = summarizeBoundary(ledger, 'TOOL');
  return {
    task_id: task.task_id,
    strategy,
    task_success: evaluated.task_success,
    validity: evaluated.validity,
    relationship_checks: evaluated.relationship_checks,
    restore_correctness: evaluated.restore_correctness,
    tool_status: evaluated.tool_status,
    representation_counts: agent.category_counts,
    exposure: {
      agent,
      tool,
      normalized_exposure: null,
      oracle_relative_raw_value_reduction: strategy === 'ORACLE_MIN_DISCLOSURE'
        ? 1 - agent.raw_exposure_count / task.sensitive_entities.length
        : null,
      ledger_reference: `${task.task_id}/${strategy}`,
      ledger
    },
    agent_input: transformed.agent_input,
    candidate_output: candidateOutput,
    restored_output: evaluated.restored_output
  };
}

function runBenchmark(fixture = loadFixture()) {
  const oracleSearch = searchAllOraclePlans(fixture);
  const searchByTask = new Map(oracleSearch.map((result) => [result.task_id, result]));
  const results = [];
  for (const task of fixture.tasks) {
    for (const strategy of STRATEGIES) {
      results.push(runTaskStrategy(fixture, task, strategy, searchByTask.get(task.task_id)));
    }
  }
  for (const task of fixture.tasks) {
    const sameTask = results.filter((result) => result.task_id === task.task_id);
    const raw = sameTask.find((result) => result.strategy === 'RAW_DISCLOSURE');
    for (const result of sameTask) {
      result.exposure.normalized_exposure = raw.exposure.agent.exposure_score === 0
        ? null
        : result.exposure.agent.exposure_score / raw.exposure.agent.exposure_score;
    }
  }
  const strategySummary = Object.fromEntries(STRATEGIES.map((strategy) => {
    const selected = results.filter((result) => result.strategy === strategy);
    return [strategy, {
      successful_tasks: selected.filter((result) => result.task_success).length,
      total_tasks: selected.length,
      agent_exposure_score: selected.reduce((sum, result) => sum + result.exposure.agent.exposure_score, 0),
      tool_exposure_score: selected.reduce((sum, result) => sum + result.exposure.tool.exposure_score, 0)
    }];
  }));
  return {
    benchmark_version: fixture.benchmark_version,
    status: 'frozen_deterministic_benchmark',
    execution_kind: 'deterministic_reference_solver_no_llm',
    oracle_search_objective: 'component_wise_privacy_order_not_weighted_exposure',
    total_combinations: results.length,
    strategy_summary: strategySummary,
    oracle_search: oracleSearch,
    results
  };
}

function parseCli(argv) {
  if (argv.length === 0) return {outputPath: null};
  if (argv.length === 2 && argv[0] === '--output') return {outputPath: path.resolve(argv[1])};
  throw new Error('usage: node src/md-bench-v0.2.js [--output <result.json>]');
}

if (require.main === module) {
  const {outputPath} = parseCli(process.argv.slice(2));
  const report = runBenchmark();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    fs.writeFileSync(outputPath, json, 'utf8');
    process.stdout.write(`${JSON.stringify({output: outputPath, total_combinations: report.total_combinations})}\n`);
  } else {
    process.stdout.write(json);
  }
}

module.exports = {
  DEFAULT_FIXTURE_PATH,
  REPRESENTATIONS,
  STRATEGIES,
  TASK_IDS,
  loadFixture,
  runBenchmark,
  runTaskStrategy,
  summarizeBoundary
};
