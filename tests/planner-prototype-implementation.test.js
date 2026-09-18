'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const planner = require('../src/planner-prototype-implementation');

function completedPredictionResponse(prediction) {
  return [{
    http_status: 200,
    latency_ms: 1,
    response: {
      status: 'completed',
      model: 'deepseek-flash',
      output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(prediction)}]}]
    }
  }];
}

test('Planner implementation keeps frozen prompt, P0 projection, and request determinism', () => {
  const assets = planner.loadPlannerAssets();
  assert.equal(planner.sha256(planner.readInitialPrompt()), planner.INITIAL_PROMPT_SHA256);
  assert.equal(planner.p0ProjectionRegression(assets).pass, true);
  const first = planner.buildProviderVisibleProjection(assets.dev);
  const second = planner.buildProviderVisibleProjection(assets.dev);
  assert.equal(planner.canonicalJson(first), planner.canonicalJson(second));
  assert.equal(planner.sha256(planner.canonicalBytes(first)), planner.sha256(planner.canonicalBytes(second)));
  for (let index = 0; index < first.length; index += 1) {
    const left = planner.buildPlannerRequest(first[index], {assets});
    const right = planner.buildPlannerRequest(second[index], {assets});
    assert.equal(planner.canonicalJson(left), planner.canonicalJson(right));
    assert.equal(/MD-[A-Z]+-[0-9]{2}/.test(planner.canonicalJson(left)), false);
  }
});

test('frozen prompt resolver preserves initial bytes and admits only the frozen revised provenance', () => {
  const assets = planner.loadPlannerAssets();
  const initial = planner.resolveFrozenPlannerPrompt('initial', assets);
  const revised = planner.resolveFrozenPlannerPrompt('revised', assets);
  assert.equal(initial.sha256, planner.INITIAL_PROMPT_SHA256);
  assert.equal(revised.sha256, planner.REVISED_PROMPT_SHA256);
  assert.equal(revised.revision_provenance.classification_sha256, planner.INITIAL_FAILURE_CLASSIFICATION_SHA256);
  assert.equal(revised.revision_provenance.prompt_diff_sha256, planner.PROMPT_DIFF_SHA256);
  assert.equal(revised.revision_provenance.revision_freeze_commit, planner.REVISION_FREEZE_COMMIT);
  assert.equal(planner.canonicalJson(
    planner.buildPlannerRequest(planner.buildProviderVisibleProjection(assets.dev)[0], {assets})
  ), planner.canonicalJson(
    planner.buildPlannerRequest(planner.buildProviderVisibleProjection(assets.dev)[0], {assets, promptVersion: 'initial'})
  ));
});

test('revised provenance gate rejects every frozen-contract mutation before dispatch', () => {
  const assets = planner.loadPlannerAssets();
  const record = JSON.parse(fs.readFileSync(planner.REVISION_DECISION_PATH, 'utf8'));
  const classificationBytes = fs.readFileSync(planner.INITIAL_FAILURE_CLASSIFICATION_PATH);
  const revisedPrompt = fs.readFileSync(planner.REVISED_PROMPT_PATH);
  const diffBytes = fs.readFileSync(planner.PROMPT_DIFF_PATH);
  const gate = (overrides = {}) => planner.revisionProvenanceGate({
    record: overrides.record ?? record,
    classificationBytes: overrides.classificationBytes ?? classificationBytes,
    revisedPrompt: overrides.revisedPrompt ?? revisedPrompt,
    diffBytes: overrides.diffBytes ?? diffBytes,
    assets
  }).ok;
  assert.equal(gate(), true);
  assert.equal(gate({revisedPrompt: Buffer.concat([revisedPrompt, Buffer.from('x')])}), false);
  assert.equal(gate({diffBytes: Buffer.concat([diffBytes, Buffer.from('x')])}), false);
  assert.equal(gate({classificationBytes: Buffer.concat([classificationBytes, Buffer.from('x')])}), false);
  const inadmissible = planner.clone(record);
  inadmissible.revision_admissibility.status = 'FAIL';
  assert.equal(gate({record: inadmissible}), false);
  const incomplete = planner.clone(record);
  incomplete.revised_batch.planned_runs.pop();
  assert.equal(gate({record: incomplete}), false);
  const selective = planner.clone(record);
  selective.revised_batch.planned_runs[2].task_id = 'MD-EQ-01';
  assert.equal(gate({record: selective}), false);
  const unfrozen = planner.clone(record);
  unfrozen.revised_prompt_frozen_before_first_dispatch = false;
  assert.equal(gate({record: unfrozen}), false);
});

test('initial and revised batches share the canonical single-run execution path', async () => {
  const assets = planner.loadPlannerAssets();
  const inputs = planner.buildProviderVisibleProjection(assets.dev);
  const scripts = new Map();
  for (let index = 0; index < planner.TASK_IDS.length; index += 1) {
    const runId = `planner-dev-v0.1/revised/${String(index + 1).padStart(3, '0')}/${planner.TASK_IDS[index]}`;
    const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[index], inputs[index]);
    scripts.set(runId, completedPredictionResponse(prediction));
  }
  const provider = new planner.FakeProvider(scripts);
  const batch = await planner.runPlannerDevBatch({
    provider, promptVersion: 'revised', assets, clockFactory: () => new planner.FakeClock()
  });
  assert.equal(batch.results.length, 7);
  assert.equal(provider.calls.length, 7);
  assert.deepEqual(batch.results.map((result) => result.artifact.run_identity.run_id),
    planner.TASK_IDS.map((taskId, index) => `planner-dev-v0.1/revised/${String(index + 1).padStart(3, '0')}/${taskId}`));
  assert.ok(batch.results.every((result) =>
    result.artifact.run_identity.prompt_version === 'revised' &&
    result.artifact.provenance.prompt_sha256 === planner.REVISED_PROMPT_SHA256 &&
    planner.schemaErrors(assets.artifactSchema, result.artifact).length === 0));
  assert.ok(provider.calls.every((call) => !planner.TASK_IDS.some((taskId) =>
    planner.canonicalJson(call.request).includes(taskId))));
  assert.equal(planner.p0ProjectionRegression(assets).pass, true);
});

test('revised dispatch guard fails closed before the provider is called', async () => {
  const assets = planner.loadPlannerAssets();
  const prepared = planner.preparePlannerRun({caseIndex: 0, promptVersion: 'revised', assets});
  prepared.promptSha256 = '0'.repeat(64);
  const provider = new planner.FakeProvider(new Map());
  await assert.rejects(
    planner.executePlannerRun(prepared, provider, {assets, clock: new planner.FakeClock()}),
    /REVISED_PROMPT_CHANGED_BEFORE_DISPATCH/
  );
  assert.equal(provider.calls.length, 0);
});

test('all seven opaque Gold-shaped predictions pass authority, No-Solver, Gold, and compiler layers', () => {
  const assets = planner.loadPlannerAssets();
  const inputs = planner.buildProviderVisibleProjection(assets.dev);
  for (let index = 0; index < 7; index += 1) {
    const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[index], inputs[index]);
    assert.equal(planner.validatePrediction(prediction, assets).valid, true);
    const result = planner.evaluatePlannerPrediction({
      plannerInput: inputs[index], seedCase: assets.seeds.cases[index], prediction, assets
    });
    assert.equal(result.evaluator_result.compiler_relation, 'ORACLE_EXACT');
    assert.equal(result.validation.authority_verification.status, 'PASS');
    assert.equal(result.validation.no_solver_verification.status, 'PASS');
    assert.equal(result.validation.gold_comparison.status, 'PASS');
    assert.equal(result.validation.compiler_qualification.status, 'PASS');
  }
});

test('single-run primitive owns one request and retries only transient transport failures', async () => {
  const assets = planner.loadPlannerAssets();
  const input = planner.buildProviderVisibleProjection(assets.dev)[0];
  const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[0], input);
  const prepared = planner.preparePlannerRun({caseIndex: 0, assets});
  const provider = new planner.FakeProvider(new Map([
    [prepared.run.run_id, [
      {http_status: 429, retry_after: '1', response: null, transport_failure: false},
      ...completedPredictionResponse(prediction)
    ]]
  ]));
  const result = await planner.executePlannerRun(prepared, provider, {
    assets,
    clock: new planner.FakeClock()
  });
  assert.equal(result.artifact.request.attempt_count, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].request && planner.canonicalJson(provider.calls[0].request), planner.canonicalJson(provider.calls[1].request));
  assert.equal(result.artifact.evaluator_result.compiler_relation, 'ORACLE_EXACT');

  const invalidProvider = new planner.FakeProvider(new Map([
    [prepared.run.run_id, [
      ...completedPredictionResponse('{not-json')
    ]]
  ]));
  const invalid = await planner.executePlannerRun(prepared, invalidProvider, {
    assets,
    clock: new planner.FakeClock()
  });
  assert.equal(invalidProvider.calls.length, 1);
  assert.equal(invalid.artifact.evaluator_result.terminal_status, 'INVALID_OUTPUT');
});

test('artifact and revision records remain closed and secret-free', async () => {
  const assets = planner.loadPlannerAssets();
  const prepared = planner.preparePlannerRun({caseIndex: 0, assets});
  const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[0], prepared.plannerInput);
  const provider = new planner.FakeProvider(new Map([[prepared.run.run_id, completedPredictionResponse(prediction)]]));
  const result = await planner.executePlannerRun(prepared, provider, {assets, clock: new planner.FakeClock()});
  assert.deepEqual(planner.schemaErrors(assets.artifactSchema, result.artifact), []);
  assert.deepEqual(planner.scanSecrets(result.artifact), []);
  const decision = planner.buildNoRevisionDecision('a'.repeat(64));
  assert.deepEqual(planner.schemaErrors(assets.revisionSchema, decision), []);
  assert.equal(decision.decision, 'NO_REVISION');
  assert.deepEqual(planner.verifyFrozenIntegrity().mismatches, []);
});

test('authority, No-Solver, malformed, and status failures fail closed', () => {
  const assets = planner.loadPlannerAssets();
  const input = planner.buildProviderVisibleProjection(assets.dev)[0];
  const seed = assets.seeds.cases[0];
  const prediction = planner.opaqueGoldPrediction(seed, input);
  const forged = JSON.parse(JSON.stringify(prediction));
  forged.requirements[0].authority_witness.support_ref = 'op.slot.003';
  assert.equal(planner.verifyAuthority(input, forged).status, 'FAIL');
  const answerLeak = JSON.parse(JSON.stringify(prediction));
  answerLeak.explanation = {selected_plan: ['STABLE_TOKEN']};
  assert.equal(planner.verifyNoSolver(answerLeak).status, 'FAIL');
  assert.equal(planner.classifyPlannerAttempt({http_status: 200, response: {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: '{bad'}]}]}}, assets).status, 'INVALID_OUTPUT');
  const extra = JSON.parse(JSON.stringify(prediction));
  extra.extra = true;
  assert.equal(planner.validatePrediction(extra, assets).valid, false);
  for (const status of ['UNCERTAIN', 'INVALID']) {
    const candidate = status === 'INVALID' ? {status, task_ir: null, requirements: []} : {...prediction, status};
    assert.equal(planner.validatePrediction(candidate, assets).valid, true);
  }
});

function extraRequirements(prediction, count) {
  const base = prediction.requirements[0];
  return Array.from({length: count}, (_, index) => {
    const extra = planner.clone(base);
    extra.requirement_id = `req.extra.${String(index + 1).padStart(3, '0')}`;
    const variants = [
      {family: 'identity', name: 'identity', parameters: {}},
      {family: 'property', name: 'ordering', parameters: {direction: 'ASCENDING'}},
      {family: 'property', name: 'domain', parameters: {granularity: 'EMAIL_DOMAIN'}}
    ];
    extra.capability = variants[index];
    return extra;
  });
}

test('capability metrics use canonical requirement-set intersection and difference', () => {
  const assets = planner.loadPlannerAssets();
  const inputs = planner.buildProviderVisibleProjection(assets.dev);

  const semanticGold = planner.clone(assets.seeds.cases[1].planner_document);
  const semanticPrediction = {
    status: 'CONFIDENT',
    task_ir: semanticGold.task_ir,
    requirements: semanticGold.capability_requirements.requirements
  };
  assert.deepEqual(
    planner.capabilityMetrics(semanticPrediction, assets.seeds.cases[1], inputs[1]),
    {tp: 1, fp: 0, fn: 0}
  );

  const expected = [
    ['MD-GROUP-02', 1, 2, 0],
    ['MD-LOC-04', 1, 3, 0],
    ['MD-GRAPH-06', 1, 2, 1]
  ];
  for (const [taskId, tp, fp, fn] of expected) {
    const index = planner.TASK_IDS.indexOf(taskId);
    const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[index], inputs[index]);
    if (taskId === 'MD-GRAPH-06') prediction.requirements.pop();
    prediction.requirements.push(...extraRequirements(prediction, taskId === 'MD-GROUP-02' ? 2 : taskId === 'MD-LOC-04' ? 3 : 2));
    assert.deepEqual(
      planner.capabilityMetrics(prediction, assets.seeds.cases[index], inputs[index]),
      {tp, fp, fn},
      taskId
    );
  }

  const wrongTarget = planner.opaqueGoldPrediction(assets.seeds.cases[0], inputs[0]);
  wrongTarget.requirements[0].targets[0].target_role = 'VALUE';
  assert.deepEqual(
    planner.capabilityMetrics(wrongTarget, assets.seeds.cases[0], inputs[0]),
    {tp: 0, fp: 1, fn: 1}
  );
});

test('unsafe prediction accounting counts rejected authority violations and answer leakage', () => {
  const assets = planner.loadPlannerAssets();
  const input = planner.buildProviderVisibleProjection(assets.dev)[0];
  const prediction = planner.opaqueGoldPrediction(assets.seeds.cases[0], input);
  prediction.requirements[0].authority_witness.support_ref = 'op.slot.003';
  const authorityEvaluation = planner.evaluatePlannerPrediction({
    plannerInput: input, seedCase: assets.seeds.cases[0], prediction, assets
  });
  assert.deepEqual(planner.unsafeEvaluation(authorityEvaluation), {
    authority_violation: true,
    answer_leakage: false
  });
  assert.equal(authorityEvaluation.validation.authority_verification.status, 'FAIL');
  const authorityUnsafe = planner.unsafeEvaluation(authorityEvaluation);
  const authorityAccepted = (authorityUnsafe.authority_violation || authorityUnsafe.answer_leakage) &&
    authorityEvaluation.validation.authority_verification.status === 'PASS' &&
    authorityEvaluation.validation.no_solver_verification.status === 'PASS';
  assert.equal(authorityAccepted, false);

  const leakageEvaluation = {
    validation: {
      authority_verification: {status: 'PASS', error_codes: []},
      no_solver_verification: {status: 'FAIL', error_codes: ['NO_SOLVER_SELECTED_PLAN']}
    },
    evaluator_result: {primary_errors: []}
  };
  assert.deepEqual(planner.unsafeEvaluation(leakageEvaluation), {
    authority_violation: false,
    answer_leakage: true
  });
});

test('frozen seven-task capability denominator keeps invalid and security-invalid tasks in macro scores', () => {
  const {metricScore} = require('../src/run-planner-evaluation-replay');
  const values = [
    [0, 3, 1], [1, 2, 0], [0, 3, 1], [1, 3, 0],
    [0, 0, 2], [1, 2, 1], [0, 0, 2]
  ];
  const scores = values.map(([tp, fp, fn]) => metricScore(tp, fp, fn));
  const tp = values.reduce((sum, value) => sum + value[0], 0);
  const fp = values.reduce((sum, value) => sum + value[1], 0);
  const fn = values.reduce((sum, value) => sum + value[2], 0);
  assert.deepEqual({tp, fp, fn}, {tp: 3, fp: 13, fn: 7});
  assert.equal(metricScore(tp, fp, fn).precision, 3 / 16);
  assert.equal(metricScore(tp, fp, fn).recall, 3 / 10);
  assert.ok(Math.abs(scores.reduce((sum, score) => sum + score.precision, 0) / scores.length - 11 / 84) < 1e-12);
  assert.ok(Math.abs(scores.reduce((sum, score) => sum + score.recall, 0) / scores.length - 5 / 14) < 1e-12);
});
