'use strict';

/*
 * The Planner prototype is deliberately a thin contract adapter.  The
 * provider transport and retry state machine remain owned by
 * llm-experiment.js; this file owns only the Planner projection, verification
 * and artifact glue.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const {
  DeepSeekResponsesAdapter,
  FakeClock,
  FakeProvider,
  TRANSPORT_CONTRACT,
  canonicalJson,
  executeWithRetry,
  retryDecision,
  sha256: sharedSha256,
  validateAgainstSchema: legacyValidateAgainstSchema
} = require('./llm-experiment');

const ROOT = path.resolve(__dirname, '..');
const PROMPT_PATH = path.join(ROOT, 'prompts', 'planner-prototype-v0.1.txt');
const DEV_PATH = path.join(ROOT, 'fixtures', 'planner-prototype-dev-cases-v0.1.1.json');
const INPUT_SCHEMA_PATH = path.join(ROOT, 'fixtures', 'planner-prototype-input-schema-v0.1.1.json');
const OUTPUT_SCHEMA_PATH = path.join(ROOT, 'fixtures', 'planner-prototype-output-schema-v0.1.json');
const ARTIFACT_SCHEMA_PATH = path.join(ROOT, 'fixtures', 'planner-prototype-artifact-schema-v0.1.json');
const REVISION_SCHEMA_PATH = path.join(ROOT, 'fixtures', 'planner-prototype-development-revision-schema-v0.1.2.json');
const SEEDS_PATH = path.join(ROOT, 'fixtures', 'planner-seed-cases-v0.2.1.json');
const CATALOG_PATH = path.join(ROOT, 'fixtures', 'planner-representation-catalog-v0.2.1.json');
const CONTRACT_PATH = path.join(ROOT, 'docs', 'planner-prototype-contract-v0.1.2.md');
const REVISED_PROMPT_PATH = path.join(ROOT, 'prompts', 'planner-prototype-v0.1-revised.txt');
const REVISION_DECISION_PATH = path.join(ROOT, 'artifacts', 'planner-development', 'planner-prototype-v0.1-development-revision-decision.json');
const INITIAL_FAILURE_CLASSIFICATION_PATH = path.join(ROOT, 'artifacts', 'planner-development', 'planner-prototype-v0.1-initial-failure-classification.json');
const PROMPT_DIFF_PATH = path.join(ROOT, 'artifacts', 'planner-development', 'planner-prototype-v0.1-prompt-exact-diff.json');

const INITIAL_PROMPT_SHA256 = '6832acad77c8182be79bd2aec8f278eb533261bbf939108b5cf52f4a4ac66a5d';
const INITIAL_FAILURE_CLASSIFICATION_SHA256 = '7857308501fda5ae2bcf8dfdb7513009c99847f535a1012fb41e6a73e1bf99a8';
const REVISED_PROMPT_SHA256 = 'dc4fb968785b14e34dd37d651ef6a7dacc11b4c3b4ebd3bc125579fa0ec3fa7b';
const PROMPT_DIFF_SHA256 = 'd85ac3032e40aa8454c5eff914b3c87e23eb0f66af743b89a5fa2160a7e1ab37';
const REVISION_FREEZE_COMMIT = '449708886c30518caa7aa8d620b00b4855d2491c';
const PLANNER_SPEC = {
  commit: '6b152f738e8b4f1d4a0186a36bb7466e40de88db',
  tag_object: '3b45322d29454134aff345b2413121f1b37008fa',
  tree: '54f4dc2d52af0ef3e1402528b510e6c91463b6fa'
};
const PROTOTYPE_CONTRACT = {
  commit: '547b82c8f1d145b5b0ef786549f6c9a41184e079',
  tag_object: '82024f843e6ad369eae4240692aa40284ed00e5f',
  tree: '3e5512840b337f8fc8096eb42dcc20b0ce8f90d7'
};
const P0_CONTRACT = {
  commit: '8d3aeb616a75f20d72a920e6240ed716c6cd8ace',
  tag_object: '66377fc8cf451313c2c6ca5d27f0b81271dba54b',
  tree: '11994550cc464ec38df5812265a875abd354980c'
};
const TASK_IDS = [
  'MD-EQ-01', 'MD-GROUP-02', 'MD-ORDER-03', 'MD-LOC-04',
  'MD-CROSS-05', 'MD-GRAPH-06', 'MD-TOOL-07'
];
const SLOT_POOL = ['op.slot.001', 'op.slot.002', 'op.slot.003'];
const TRUSTED_AUTHORITY = new Set([
  'USER_INTENT', 'TRUSTED_WORKFLOW', 'DATA_SCHEMA', 'TOOL_SCHEMA'
]);
const VALID_STATUSES = new Set(['CONFIDENT', 'UNCERTAIN', 'INVALID']);
const PLANNER_TRANSPORT = Object.freeze({
  ...TRANSPORT_CONTRACT,
  max_retries: 1
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(stable(value)), 'utf8');
}

function sha256(value) {
  return sharedSha256(value);
}

function loadPlannerAssets() {
  return {
    dev: readJson(DEV_PATH),
    inputSchema: readJson(INPUT_SCHEMA_PATH),
    outputSchema: readJson(OUTPUT_SCHEMA_PATH),
    artifactSchema: readJson(ARTIFACT_SCHEMA_PATH),
    revisionSchema: readJson(REVISION_SCHEMA_PATH),
    seeds: readJson(SEEDS_PATH),
    catalog: readJson(CATALOG_PATH)
  };
}

function readInitialPrompt() {
  const bytes = fs.readFileSync(PROMPT_PATH);
  if (sha256(bytes) !== INITIAL_PROMPT_SHA256) throw new Error('INITIAL_PROMPT_HASH_MISMATCH');
  return bytes;
}

function frozenRevisionPathsUnchanged() {
  const paths = [
    'artifacts/planner-development/planner-prototype-v0.1-development-revision-decision.json',
    'artifacts/planner-development/planner-prototype-v0.1-initial-failure-classification.json',
    'artifacts/planner-development/planner-prototype-v0.1-prompt-exact-diff.json',
    'prompts/planner-prototype-v0.1-revised.txt'
  ];
  return paths.every((relativePath) => {
    try {
      childProcess.execFileSync('git', ['diff', '--quiet', REVISION_FREEZE_COMMIT, '--', relativePath], {cwd: ROOT, stdio: 'ignore'});
      return true;
    } catch {
      return false;
    }
  });
}

function revisionProvenanceGate({record, classificationBytes, revisedPrompt, diffBytes, assets = loadPlannerAssets(), checkFrozenCommit = false} = {}) {
  const fail = (reason) => ({ok: false, error_code: 'REVISED_PROMPT_NOT_FROZEN', reason});
  if (!record || record.decision !== 'ONE_GENERAL_REVISION') return fail('DECISION_NOT_ONE_GENERAL_REVISION');
  if (schemaErrors(assets.revisionSchema, record).length) return fail('REVISION_RECORD_SCHEMA_INVALID');
  if (record.revision_decided_after_initial_batch !== true || record.revised_prompt_frozen_before_first_dispatch !== true) return fail('REVISION_NOT_FROZEN_BEFORE_DISPATCH');
  if (record.initial_prompt_sha256 !== INITIAL_PROMPT_SHA256 || record.initial_batch.failure_classification_sha256 !== INITIAL_FAILURE_CLASSIFICATION_SHA256) return fail('INITIAL_PROVENANCE_HASH_MISMATCH');
  if (!record.initial_batch.completed || canonicalJson(record.initial_batch.run_ids) !== canonicalJson(TASK_IDS.map((taskId, index) => `planner-dev-v0.1/initial/${String(index + 1).padStart(3, '0')}/${taskId}`))) return fail('INITIAL_BATCH_INCOMPLETE');
  let classification;
  try { classification = JSON.parse(Buffer.from(classificationBytes).toString('utf8')); } catch { return fail('CLASSIFICATION_INVALID'); }
  if (sha256(Buffer.from(classificationBytes)) !== record.initial_batch.failure_classification_sha256 || classification.status !== 'FROZEN' || classification.initial_failure_classification_frozen !== true || classification.cases?.length !== 7) return fail('CLASSIFICATION_NOT_FROZEN');
  if (record.revised_prompt_sha256 !== REVISED_PROMPT_SHA256 || sha256(Buffer.from(revisedPrompt)) !== record.revised_prompt_sha256) return fail('REVISED_PROMPT_HASH_MISMATCH');
  if (record.prompt_diff_sha256 !== PROMPT_DIFF_SHA256 || sha256(Buffer.from(diffBytes)) !== record.prompt_diff_sha256 || !Buffer.from(diffBytes).equals(exactPromptDiffBytes(Buffer.from(revisedPrompt)))) return fail('PROMPT_DIFF_HASH_MISMATCH');
  if (record.prompt_diff_format !== 'planner-prompt-exact-diff-v0.1' || record.revision_admissibility?.status !== 'PASS' || record.revision_admissibility?.zero_shot !== true || !revisionAdmissible(Buffer.from(revisedPrompt), record.general_revision_rationale, assets)) return fail('REVISION_INADMISSIBLE');
  if (record.revised_prompt_artifact?.path !== 'prompts/planner-prototype-v0.1-revised.txt' || record.revised_prompt_artifact?.diff_path !== 'artifacts/planner-development/planner-prototype-v0.1-prompt-exact-diff.json') return fail('REVISION_ARTIFACT_PATH_MISMATCH');
  const planned = record.revised_batch?.planned_runs ?? [];
  if (record.revised_batch?.dispatch_policy !== 'FULL_SEVEN_SERIAL_NO_SELECTIVE_RERUN' || canonicalJson(planned) !== canonicalJson(revisedRunManifest(record.revised_prompt_sha256))) return fail('REVISED_MANIFEST_INVALID');
  if (checkFrozenCommit) {
    try {
      if (childProcess.execFileSync('git', ['rev-parse', `${REVISION_FREEZE_COMMIT}^{commit}`], {cwd: ROOT, encoding: 'utf8'}).trim() !== REVISION_FREEZE_COMMIT || !frozenRevisionPathsUnchanged()) return fail('REVISION_FREEZE_COMMIT_MISMATCH');
    } catch { return fail('REVISION_FREEZE_COMMIT_MISMATCH'); }
  }
  return {ok: true, prompt_sha256: record.revised_prompt_sha256, classification_sha256: record.initial_batch.failure_classification_sha256, prompt_diff_sha256: record.prompt_diff_sha256, revision_freeze_commit: REVISION_FREEZE_COMMIT};
}

function resolveFrozenPlannerPrompt(promptVersion = 'initial', assets = loadPlannerAssets()) {
  if (promptVersion === 'initial') {
    const bytes = readInitialPrompt();
    return {prompt_version: 'initial', bytes, sha256: INITIAL_PROMPT_SHA256, revision_provenance: null};
  }
  if (promptVersion !== 'revised') throw new Error('PLANNER_PROMPT_VERSION_INVALID');
  let record;
  try {
    record = readJson(REVISION_DECISION_PATH);
    const classificationBytes = fs.readFileSync(INITIAL_FAILURE_CLASSIFICATION_PATH);
    const revisedPrompt = fs.readFileSync(REVISED_PROMPT_PATH);
    const diffBytes = fs.readFileSync(PROMPT_DIFF_PATH);
    const gate = revisionProvenanceGate({record, classificationBytes, revisedPrompt, diffBytes, assets, checkFrozenCommit: true});
    if (!gate.ok) throw new Error(gate.error_code);
    return {prompt_version: 'revised', bytes: revisedPrompt, sha256: gate.prompt_sha256, revision_provenance: gate};
  } catch (error) {
    if (error.message === 'REVISED_PROMPT_NOT_FROZEN') throw error;
    throw new Error('REVISED_PROMPT_NOT_FROZEN');
  }
}

function resolveSchema(schema, root) {
  if (!schema.$ref) return schema;
  const prefix = '#/$defs/';
  if (!schema.$ref.startsWith(prefix)) throw new Error(`UNSUPPORTED_SCHEMA_REF:${schema.$ref}`);
  return root.$defs?.[schema.$ref.slice(prefix.length)] ?? null;
}

function schemaErrors(schema, value, root = schema, at = '$') {
  const resolved = resolveSchema(schema, root);
  if (!resolved) return [`${at}: unresolved schema reference`];
  if (resolved.oneOf) {
    const matches = resolved.oneOf.filter((candidate) => schemaErrors(candidate, value, root, at).length === 0);
    return matches.length === 1 ? [] : [`${at}: oneOf mismatch`];
  }
  if (resolved.const !== undefined && canonicalJson(value) !== canonicalJson(resolved.const)) return [`${at}: const mismatch`];
  if (resolved.enum && !resolved.enum.includes(value)) return [`${at}: enum mismatch`];
  if (resolved.type === 'null' && value !== null) return [`${at}: expected null`];
  if (resolved.type === 'string') {
    if (typeof value !== 'string') return [`${at}: expected string`];
    if (resolved.minLength !== undefined && value.length < resolved.minLength) return [`${at}: too short`];
    if (resolved.pattern && !(new RegExp(resolved.pattern).test(value))) return [`${at}: pattern mismatch`];
  }
  if (resolved.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${at}: expected number`];
  if (resolved.type === 'integer' && !Number.isInteger(value)) return [`${at}: expected integer`];
  if ((resolved.type === 'number' || resolved.type === 'integer') && resolved.minimum !== undefined && value < resolved.minimum) return [`${at}: below minimum`];
  if ((resolved.type === 'number' || resolved.type === 'integer') && resolved.maximum !== undefined && value > resolved.maximum) return [`${at}: above maximum`];
  if ((resolved.type === 'number' || resolved.type === 'integer') && resolved.exclusiveMinimum !== undefined && value <= resolved.exclusiveMinimum) return [`${at}: below exclusive minimum`];
  if (resolved.type === 'array') {
    if (!Array.isArray(value)) return [`${at}: expected array`];
    if (resolved.minItems !== undefined && value.length < resolved.minItems) return [`${at}: too few items`];
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) return [`${at}: too many items`];
    if (resolved.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return [`${at}: duplicate items`];
    return value.flatMap((item, index) => schemaErrors(resolved.items, item, root, `${at}[${index}]`));
  }
  if (resolved.type === 'object' || resolved.properties || resolved.required || resolved.additionalProperties !== undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected object`];
    for (const required of resolved.required ?? []) {
      if (!Object.hasOwn(value, required)) return [`${at}: missing ${required}`];
    }
    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      const extra = Object.keys(value).find((key) => !allowed.has(key));
      if (extra) return [`${at}: unexpected ${extra}`];
    }
    return Object.entries(resolved.properties ?? {}).flatMap(([key, child]) =>
      Object.hasOwn(value, key) ? schemaErrors(child, value[key], root, `${at}.${key}`) : []);
  }
  return [];
}

function validateSchema(schema, value) {
  const errors = schemaErrors(schema, value);
  return {valid: errors.length === 0, errors};
}

function validatePlannerInput(plannerInput, assets = loadPlannerAssets()) {
  return validateSchema(assets.inputSchema, plannerInput);
}

function validatePrediction(prediction, assets = loadPlannerAssets()) {
  return validateSchema(assets.outputSchema, prediction);
}

function buildProviderVisibleProjection(dev = loadPlannerAssets().dev) {
  if (dev.dev_fixture_version !== 'planner-prototype-dev-cases-v0.1.1' ||
      dev.model_visible_projection !== 'cases[].planner_input') {
    throw new Error('DEV_FIXTURE_PROJECTION_CONTRACT_MISMATCH');
  }
  const projection = dev.cases.map((item) => clone(item.planner_input));
  projection.forEach((plannerInput) => {
    const result = validatePlannerInput(plannerInput);
    if (!result.valid) throw new Error(`PLANNER_INPUT_INVALID:${result.errors[0]}`);
  });
  return projection;
}

function collectStrings(value, result = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, result));
  else if (typeof value === 'string') result.add(value);
  return result;
}

function sourceMap(plannerInput) {
  return new Map(plannerInput.authority_context.sources.map((source) => [source.source_id, source]));
}

function operationMap(document) {
  return new Map(document.task_ir.operations.map((operation) => [operation.operation_id, operation]));
}

function exactOperationInput(operation, target) {
  return operation.inputs.some((input) => canonicalJson(input) === canonicalJson(target));
}

function authorityError(plannerInput, document, requirement) {
  const witness = requirement.authority_witness;
  const source = sourceMap(plannerInput).get(witness.source_id);
  if (!source || !TRUSTED_AUTHORITY.has(source.authority_class) || source.authority_class !== witness.authority_class) return 'AUTHORITY_VIOLATION';
  if (!source.supports.some((support) => support.support_type === witness.support_type && support.support_ref === witness.support_ref)) return 'AUTHORITY_VIOLATION';
  const operation = operationMap(document).get(requirement.operation_ref);
  if (!operation || !requirement.targets.every((target) => exactOperationInput(operation, target))) return 'AUTHORITY_VIOLATION';
  if (witness.support_type === 'OPERATION') {
    return witness.authority_class === 'USER_INTENT' && witness.support_ref === requirement.operation_ref && requirement.boundary === 'AGENT' ? null : 'AUTHORITY_VIOLATION';
  }
  if (witness.support_type === 'SCHEMA_FIELD') {
    return witness.authority_class === 'DATA_SCHEMA' && requirement.boundary === 'AGENT' && requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' && requirement.targets.some((target) => target.field_ref === witness.support_ref) ? null : 'AUTHORITY_VIOLATION';
  }
  if (witness.support_type === 'WORKFLOW_RULE') {
    const refs = collectStrings({capability: requirement.capability.parameters, operation: operation.parameters});
    return witness.authority_class === 'TRUSTED_WORKFLOW' && requirement.boundary === 'AGENT' && requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' && refs.has(witness.support_ref) ? null : 'AUTHORITY_VIOLATION';
  }
  if (witness.support_type === 'SOURCE_RELATION') {
    const roles = new Set(['RELATION_SOURCE', 'RELATION_TARGET']);
    return witness.authority_class === 'DATA_SCHEMA' && requirement.boundary === 'AGENT' && requirement.scope.kind === 'DECLARED_RELATION_SET' && requirement.scope.reference === witness.support_ref && ['existing_relation', 'directionality'].includes(requirement.capability.name) && requirement.targets.every((target) => roles.has(target.target_role)) ? null : 'AUTHORITY_VIOLATION';
  }
  if (witness.support_type === 'TOOL_PARAMETER') {
    if (witness.authority_class !== 'TOOL_SCHEMA' || operation.family !== 'tool_call' || operation.role !== 'TOOL_EXECUTION' || requirement.boundary !== 'TOOL' || requirement.scope.kind !== 'DECLARED_TOOL_ARGUMENT' || requirement.scope.reference !== witness.support_ref || requirement.targets.length !== 1 || requirement.targets[0].target_role !== 'TOOL_ARGUMENT') return 'AUTHORITY_VIOLATION';
    const target = requirement.targets[0];
    return operation.tool_parameters?.some((parameter) => parameter.parameter_ref === witness.support_ref && parameter.source_field_ref === target.field_ref) ? null : 'AUTHORITY_VIOLATION';
  }
  return 'AUTHORITY_VIOLATION';
}

function slotPolicyError(document) {
  const operations = document.task_ir.operations;
  if (operations.length > SLOT_POOL.length) return 'OPERATION_SLOT_OVERFLOW';
  const expected = operations.map((unused, index) => SLOT_POOL[index]);
  if (operations.some((operation, index) => operation.operation_id !== expected[index])) return 'OPERATION_SLOT_ORDER_INVALID';
  if (new Set(operations.map((operation) => operation.operation_id)).size !== operations.length) return 'OPERATION_SLOT_DUPLICATE';
  const ids = new Set(operations.map((operation) => operation.operation_id));
  if (operations.some((operation) => operation.depends_on.some((dependency) => !ids.has(dependency)))) return 'OPERATION_DEPENDENCY_INVALID';
  return null;
}

const NO_SOLVER_KEYS = new Set([
  'answer', 'expected_answer', 'ground_truth', 'oracle', 'oracle_bridge',
  'selected_plan', 'transformation_id', 'representation', 'raw_value',
  'sensitive_value', 'selected_subset', 'rank', 'result_value', 'output_value'
]);

function noSolverError(value, at = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = noSolverError(value[index], `${at}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (NO_SOLVER_KEYS.has(key.toLowerCase())) return `NO_SOLVER_${key.toUpperCase()}`;
    const error = noSolverError(child, `${at}.${key}`);
    if (error) return error;
  }
  return null;
}

function verifyAuthority(plannerInput, prediction) {
  const slotError = slotPolicyError(prediction);
  if (slotError) return {status: 'FAIL', error_codes: [slotError]};
  const errors = prediction.requirements.map((requirement) => authorityError(plannerInput, prediction, requirement)).filter(Boolean);
  return errors.length ? {status: 'FAIL', error_codes: [...new Set(errors)]} : {status: 'PASS', error_codes: []};
}

function verifyNoSolver(prediction) {
  const error = noSolverError(prediction);
  return error ? {status: 'FAIL', error_codes: [error]} : {status: 'PASS', error_codes: []};
}

function semanticError(plannerInput, document, requirement, catalog) {
  if (Object.hasOwn(requirement, 'exact_value_required')) return 'SEMANTIC_INVALID';
  const operation = operationMap(document).get(requirement.operation_ref);
  if (!operation || !requirement.targets.every((target) => exactOperationInput(operation, target))) return 'SEMANTIC_INVALID';
  const semantic = catalog.capability_semantics.find((item) => item.name === requirement.capability.name);
  if (!semantic || semantic.family !== requirement.capability.family || requirement.targets.length < semantic.arity.minimum || requirement.targets.length > semantic.arity.maximum || !semantic.allowed_scopes.includes(requirement.scope.kind)) return 'SEMANTIC_INVALID';
  if (canonicalJson(Object.keys(requirement.capability.parameters).sort()) !== canonicalJson([...semantic.required_parameters].sort())) return 'SEMANTIC_INVALID';
  if (requirement.targets.some((target) => !semantic.target_roles.includes(target.target_role) || !semantic.applicable_field_types.includes(target.semantic_type))) return 'SEMANTIC_INVALID';
  return authorityError(plannerInput, document, requirement);
}

function trustedClaims(context) {
  return new Set((context?.sources ?? []).filter((source) => TRUSTED_AUTHORITY.has(source.authority_class)).flatMap((source) => (source.claims ?? []).map((claim) => claim.claim_id)));
}

function coverageCapabilityMatches(coverage, requirement, catalog) {
  if (coverage.capability === requirement.capability.name) return true;
  const semantic = catalog.capability_semantics.find((item) => item.name === coverage.capability);
  return Boolean(semantic?.entails.includes(requirement.capability.name));
}

function dimensionMatchesRequirement(dimension, operation, requirement, catalog) {
  if (!requirement.targets.every((target) => dimension.target_fields.some((field) => field.field_ref === target.field_ref && field.semantic_type === target.semantic_type))) return false;
  if (!dimension.operation_bindings.some((binding) => binding.operation_families.includes(operation.family) && binding.operation_roles.includes(operation.role))) return false;
  return dimension.candidate_actions.some((action) => action.coverage.some((coverage) => coverageCapabilityMatches(coverage, requirement, catalog) && canonicalJson(coverage.parameters) === canonicalJson(requirement.capability.parameters) && coverage.boundary === requirement.boundary));
}

function validateTrustedSlice(slice, catalog) {
  if (!slice || slice.catalog_version !== catalog.catalog_version || !Array.isArray(slice.dimension_refs) || slice.dimension_refs.length === 0 || new Set(slice.dimension_refs).size !== slice.dimension_refs.length) return {ok: false, reason: 'NO_TRUSTED_CATALOG_SLICE'};
  const dimensions = new Map(catalog.dimensions.map((dimension) => [dimension.dimension_ref, dimension]));
  if (!slice.dimension_refs.every((ref) => dimensions.has(ref))) return {ok: false, reason: 'NO_TRUSTED_CATALOG_SLICE'};
  return {ok: true, dimensions: slice.dimension_refs.map((ref) => dimensions.get(ref)).sort((left, right) => catalog.canonical_dimension_order.indexOf(left.dimension_ref) - catalog.canonical_dimension_order.indexOf(right.dimension_ref))};
}

function actionSatisfies(action, requirements, claims, catalog) {
  return requirements.every((requirement) => action.coverage.some((coverage) => coverageCapabilityMatches(coverage, requirement, catalog) && canonicalJson(coverage.parameters) === canonicalJson(requirement.capability.parameters) && coverage.boundary === requirement.boundary && coverage.required_preconditions.every((claim) => claims.has(claim))));
}

function compilerStructuralError(catalog) {
  const policy = catalog.structural_validation;
  if (!policy) return 'CATALOG_STRUCTURE_INVALID';
  const contractIds = new Set();
  for (const contract of catalog.transformation_contracts) {
    if (contractIds.has(contract.transformation_id)) return 'CATALOG_STRUCTURE_INVALID';
    contractIds.add(contract.transformation_id);
    if (contract.metadata_policy !== 'NO_RUNTIME_METADATA' || contract.depends_on_task_answer || contract.selects_subset || contract.introduces_rank || contract.introduces_aggregate || contract.introduces_derived_relation || !contract.uniform_across_records) return 'ANSWER_LEAKAGE';
  }
  return null;
}

function compilePrediction(prediction, plannerInput, trustedCatalogSlice, trustedContext, catalog = loadPlannerAssets().catalog) {
  const structural = compilerStructuralError(catalog);
  if (structural) return {status: 'INFEASIBLE', reasons: [structural]};
  const document = prediction.capability_requirements ? prediction : {
    schema_version: 'planner-capability-schema-v0.2.1',
    task_ir: prediction.task_ir,
    capability_requirements: {requirements: prediction.requirements},
    uncertainty: prediction.uncertainty ?? prediction.status
  };
  const requirements = document.capability_requirements.requirements;
  for (const requirement of requirements) {
    const error = semanticError(plannerInput, document, requirement, catalog);
    if (error) return {status: 'INFEASIBLE', reasons: ['SEMANTIC_REQUIREMENT_INVALID'], primary_error: error};
  }
  const slice = validateTrustedSlice(trustedCatalogSlice, catalog);
  if (!slice.ok) return {status: 'INFEASIBLE', reasons: [slice.reason]};
  const operations = operationMap(document);
  const mapping = new Map();
  for (const requirement of requirements) {
    const operation = operations.get(requirement.operation_ref);
    const matches = slice.dimensions.filter((dimension) => dimensionMatchesRequirement(dimension, operation, requirement, catalog));
    if (matches.length === 0) {
      const fullMatches = catalog.dimensions.filter((dimension) => dimensionMatchesRequirement(dimension, operation, requirement, catalog));
      return {status: 'INFEASIBLE', reasons: [fullMatches.length > 0 ? 'MISSING_REQUIRED_DIMENSION' : 'NO_ACTION_PROVIDES_CAPABILITY']};
    }
    if (matches.length > 1) return {status: 'INFEASIBLE', reasons: ['AMBIGUOUS_DIMENSION_MAPPING']};
    mapping.set(requirement.requirement_id, matches[0].dimension_ref);
  }
  const claims = trustedClaims(trustedContext);
  const selections = [];
  function visit(index, vector, actions) {
    if (index === slice.dimensions.length) {
      if (requirements.every((requirement) => {
        const dimension = mapping.get(requirement.requirement_id);
        const selected = actions.find((entry) => entry.dimension.dimension_ref === dimension);
        return selected && actionSatisfies(selected.action, [requirement], claims, catalog);
      })) selections.push({vector, actions});
      return;
    }
    const dimension = slice.dimensions[index];
    for (const action of dimension.candidate_actions) visit(index + 1, [...vector, action.level], [...actions, {dimension, action}]);
  }
  visit(0, [], []);
  if (selections.length === 0) return {status: 'INFEASIBLE', reasons: ['NO_ACTION_PROVIDES_CAPABILITY']};
  const dominates = (left, right) => left.every((level, index) => level <= right[index]) && left.some((level, index) => level < right[index]);
  const compare = (left, right) => left.findIndex((level, index) => level !== right[index]) >= 0 ? left[left.findIndex((level, index) => level !== right[index])] - right[right.findIndex((level, index) => level !== right[index])] : 0;
  const canonicalActions = (actions) => canonicalJson(actions.map(({dimension, action}) => ({dimension_ref: dimension.dimension_ref, canonical_action: action.canonical_action})));
  const minimal = selections.filter((candidate) => !selections.some((other) => dominates(other.vector, candidate.vector))).sort((left, right) => compare(left.vector, right.vector) || canonicalActions(left.actions).localeCompare(canonicalActions(right.actions)));
  const selected = minimal[0];
  return {status: 'FEASIBLE', relevant_dimensions: slice.dimensions.map((dimension) => dimension.dimension_ref), feasible_count: selections.length, pareto_minimal_count: minimal.length, selected_vector: selected.vector, selected_plan: selected.actions.map(({dimension, action}) => ({dimension_ref: dimension.dimension_ref, transformation_id: action.transformation_id}))};
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  items.forEach((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).forEach((tail) => result.push([item, ...tail])));
  return result;
}

function normalizeUnderMapping(document, requirements, mapping) {
  const operationIds = new Map(document.task_ir.operations.map((operation, index) => [operation.operation_id, mapping[index]]));
  const operations = document.task_ir.operations.map((operation) => {
    const copy = clone(operation);
    delete copy.operation_id;
    copy.depends_on = copy.depends_on.map((dependency) => operationIds.get(dependency));
    return {alpha_id: operationIds.get(operation.operation_id), operation: copy};
  }).sort((left, right) => left.alpha_id.localeCompare(right.alpha_id));
  const normalizedRequirements = requirements.map((requirement) => {
    const copy = clone(requirement);
    delete copy.requirement_id;
    copy.operation_ref = operationIds.get(copy.operation_ref);
    delete copy.authority_witness.source_id;
    if (copy.authority_witness.support_type === 'OPERATION') copy.authority_witness.support_ref = operationIds.get(copy.authority_witness.support_ref);
    return copy;
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const presentation = (document.task_ir.presentation ?? []).map((item) => {
    const copy = clone(item);
    delete copy.constraint_id;
    return copy;
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return canonicalJson({task_ir_version: document.task_ir.task_ir_version, operations, presentation, requirements: normalizedRequirements});
}

function alphaCanonical(document, requirements) {
  const labels = document.task_ir.operations.map((unused, index) => `op.alpha.${String(index + 1).padStart(3, '0')}`);
  return permutations(labels).map((permutation) => normalizeUnderMapping(document, requirements, permutation)).sort()[0];
}

function canonicalizePrediction(prediction) {
  const document = {task_ir: prediction.task_ir};
  return {schema_version: 'planner-capability-schema-v0.2.1', task_ir: clone(prediction.task_ir), capability_requirements: clone(prediction.requirements), uncertainty: prediction.status, alpha_canonical: alphaCanonical(document, prediction.requirements)};
}

function canonicalRequirementSet(prediction) {
  if (!prediction || !prediction.task_ir || !Array.isArray(prediction.requirements)) return new Set();
  const canonical = JSON.parse(canonicalizePrediction(prediction).alpha_canonical);
  return new Set(canonical.requirements.map((requirement) => canonicalJson(requirement)));
}

function capabilityMetrics(prediction, seedCase, plannerInput) {
  const goldPrediction = opaqueGoldPrediction(seedCase, plannerInput);
  const gold = canonicalRequirementSet(goldPrediction);
  const predicted = canonicalRequirementSet(prediction);
  const tp = [...gold].filter((requirement) => predicted.has(requirement)).length;
  const fp = [...predicted].filter((requirement) => !gold.has(requirement)).length;
  const fn = [...gold].filter((requirement) => !predicted.has(requirement)).length;
  return {tp, fp, fn};
}

function compareGold(prediction, seedCase) {
  const predictedDocument = {task_ir: prediction.task_ir};
  const goldDocument = seedCase.planner_document;
  const predictedCanonical = alphaCanonical(predictedDocument, prediction.requirements);
  const goldCanonical = alphaCanonical(goldDocument, goldDocument.capability_requirements.requirements);
  return {status: predictedCanonical === goldCanonical ? 'PASS' : 'FAIL', error_codes: predictedCanonical === goldCanonical ? [] : ['GOLD_MISMATCH'], exact_requirement_set_match: predictedCanonical === goldCanonical, predicted_canonical: predictedCanonical, gold_canonical: goldCanonical};
}

function notRun() { return {status: 'NOT_RUN', error_codes: []}; }

function evaluatePlannerPrediction({plannerInput, seedCase, prediction, assets = loadPlannerAssets()}) {
  const validation = {schema_validation: notRun(), authority_verification: notRun(), no_solver_verification: notRun(), canonicalization: notRun(), gold_comparison: notRun(), compiler_qualification: notRun()};
  const schema = validatePrediction(prediction, assets);
  if (!schema.valid) {
    validation.schema_validation = {status: 'FAIL', error_codes: ['INVALID_OUTPUT']};
    return {validation, canonical_prediction: null, evaluator_result: {terminal_status: 'INVALID_OUTPUT', planner_status: 'NOT_PARSED', schema_valid: false, semantic_valid: false, exact_requirement_set_match: false, capability_tp: 0, capability_fp: 0, capability_fn: seedCase.planner_document.capability_requirements.requirements.length, primary_errors: ['INVALID_OUTPUT'], compiler_relation: 'NOT_RUN'}};
  }
  validation.schema_validation = {status: 'PASS', error_codes: []};
  if (prediction.status === 'INVALID') {
    return {validation, canonical_prediction: null, evaluator_result: {terminal_status: 'EVALUATED', planner_status: 'INVALID', schema_valid: true, semantic_valid: false, exact_requirement_set_match: false, capability_tp: 0, capability_fp: 0, capability_fn: seedCase.planner_document.capability_requirements.requirements.length, primary_errors: ['PLANNER_INVALID'], compiler_relation: 'NOT_RUN'}};
  }
  validation.authority_verification = verifyAuthority(plannerInput, prediction);
  if (validation.authority_verification.status !== 'PASS') return failedSemanticResult(validation, seedCase, ['AUTHORITY_VIOLATION']);
  validation.no_solver_verification = verifyNoSolver(prediction);
  if (validation.no_solver_verification.status !== 'PASS') return failedSemanticResult(validation, seedCase, validation.no_solver_verification.error_codes);
  const canonicalPrediction = canonicalizePrediction(prediction);
  validation.canonicalization = {status: 'PASS', error_codes: []};
  const goldComparison = compareGold(prediction, seedCase);
  validation.gold_comparison = {status: goldComparison.status, error_codes: goldComparison.error_codes};
  const compiler = compilePrediction({schema_version: 'planner-capability-schema-v0.2.1', task_ir: prediction.task_ir, capability_requirements: {requirements: prediction.requirements}, uncertainty: prediction.status}, plannerInput, seedCase.trusted_catalog_slice, seedCase.trusted_context, assets.catalog);
  validation.compiler_qualification = compiler.status === 'FEASIBLE' ? {status: 'PASS', error_codes: []} : {status: 'FAIL', error_codes: compiler.reasons};
  const exact = goldComparison.status === 'PASS';
  const feasible = compiler.status === 'FEASIBLE';
  const capability = capabilityMetrics(prediction, seedCase, plannerInput);
  const errors = [...validation.gold_comparison.error_codes, ...validation.compiler_qualification.error_codes];
  return {validation, canonical_prediction: canonicalPrediction, compiler, evaluator_result: {terminal_status: 'EVALUATED', planner_status: prediction.status, schema_valid: true, semantic_valid: true, exact_requirement_set_match: exact, capability_tp: capability.tp, capability_fp: capability.fp, capability_fn: capability.fn, primary_errors: [...new Set(errors)], compiler_relation: !feasible ? 'INFEASIBLE' : exact ? 'ORACLE_EXACT' : 'INCOMPARABLE'}};
}

function failedSemanticResult(validation, seedCase, errors) {
  return {validation, canonical_prediction: null, evaluator_result: {terminal_status: 'EVALUATED', planner_status: 'CONFIDENT', schema_valid: true, semantic_valid: false, exact_requirement_set_match: false, capability_tp: 0, capability_fp: 0, capability_fn: seedCase.planner_document.capability_requirements.requirements.length, primary_errors: [...new Set(errors)], compiler_relation: 'NOT_RUN'}};
}

function unsafeEvaluation(evaluation) {
  const authorityCodes = evaluation?.validation?.authority_verification?.error_codes ?? [];
  const noSolverCodes = evaluation?.validation?.no_solver_verification?.error_codes ?? [];
  const primaryErrors = evaluation?.evaluator_result?.primary_errors ?? [];
  return {
    authority_violation: authorityCodes.includes('AUTHORITY_VIOLATION'),
    answer_leakage: noSolverCodes.some((code) => code.startsWith('NO_SOLVER_')) || primaryErrors.includes('ANSWER_LEAKAGE')
  };
}

function responseText(response) {
  if (!response || !Array.isArray(response.output)) return null;
  const parts = response.output.filter((item) => item.type === 'message').flatMap((item) => Array.isArray(item.content) ? item.content : []).filter((part) => part.type === 'output_text').map((part) => part.text);
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : null;
}

function classifyPlannerAttempt(attempt, assets = loadPlannerAssets()) {
  if (attempt.http_status === 400 || attempt.http_status === 422) return {terminal: true, status: 'REQUEST_INVALID'};
  if (attempt.http_status === 401) return {terminal: true, status: 'AUTH_FAILED'};
  if (attempt.http_status === 402) return {terminal: true, status: 'PROVIDER_FAILED'};
  if (attempt.transport_failure && !attempt.response) return {terminal: false, retryable: true, status: 'PROVIDER_FAILED'};
  if ([429, 500, 503].includes(attempt.http_status) && !attempt.response) return {terminal: false, retryable: true, status: 'PROVIDER_FAILED'};
  if (attempt.http_status !== 200 || !attempt.response) return {terminal: true, status: 'PROVIDER_FAILED'};
  if (attempt.response.status === 'incomplete') return {terminal: true, status: 'INCOMPLETE_OUTPUT'};
  if (attempt.response.status === 'failed') return {terminal: true, status: 'PROVIDER_FAILED'};
  if (attempt.response.status !== 'completed') return {terminal: true, status: 'PROVIDER_FAILED'};
  const rawOutput = responseText(attempt.response);
  if (!rawOutput) return {terminal: true, status: 'INVALID_OUTPUT', raw_output: null};
  let parsed;
  try { parsed = JSON.parse(rawOutput); } catch { return {terminal: true, status: 'INVALID_OUTPUT', raw_output: rawOutput}; }
  const schema = validatePrediction(parsed, assets);
  if (!schema.valid) return {terminal: true, status: 'INVALID_OUTPUT', raw_output: rawOutput, parsed_output: parsed};
  return {terminal: true, status: 'STRUCTURED_OUTPUT_VALID', raw_output: rawOutput, parsed_output: parsed};
}

function buildPlannerRequest(plannerInput, options = {}) {
  const assets = options.assets ?? loadPlannerAssets();
  const resolvedPrompt = resolveFrozenPlannerPrompt(options.promptVersion ?? 'initial', assets);
  const prompt = resolvedPrompt.bytes;
  if (sha256(prompt) !== resolvedPrompt.sha256) throw new Error(`${resolvedPrompt.prompt_version === 'initial' ? 'INITIAL_PROMPT' : 'REVISED_PROMPT'}_HASH_MISMATCH`);
  return {
    model: 'deepseek-flash',
    instructions: prompt.toString('utf8'),
    input: canonicalJson(plannerInput),
    reasoning: {effort: 'none'},
    temperature: 0,
    max_output_tokens: 4096,
    stream: false,
    text: {format: {type: 'json_schema', name: 'planner_prototype_v0_1', schema: assets.outputSchema}}
  };
}

function implementationCommit() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
}

function providerSnapshot(snapshot = {}) {
  const value = {
    checked_at: snapshot.checked_at ?? '2026-09-18T00:00:00Z',
    provider: 'DeepSeek',
    api_surface: 'POST /responses',
    requested_model: 'deepseek-flash',
    documented_serving_model: snapshot.documented_serving_model ?? 'DeepSeek-V4.1-Flash'
  };
  return {...value, snapshot_sha256: sha256(value)};
}

function preparePlannerRun({caseIndex, promptVersion = 'initial', experimentId = 'planner-dev-v0.1', assets = loadPlannerAssets(), snapshot}) {
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex >= 7) throw new Error('PLANNER_CASE_INDEX_INVALID');
  const resolvedPrompt = resolveFrozenPlannerPrompt(promptVersion, assets);
  const projection = buildProviderVisibleProjection(assets.dev);
  const taskId = TASK_IDS[caseIndex];
  const plannerInput = projection[caseIndex];
  const request = buildPlannerRequest(plannerInput, {assets, promptVersion});
  return {caseIndex, taskId, seedCase: assets.seeds.cases[caseIndex], plannerInput, request, schema: assets.outputSchema, run: {experiment_id: experimentId, run_id: `planner-dev-v0.1/${promptVersion}/${String(caseIndex + 1).padStart(3, '0')}/${taskId}`, run_order: caseIndex + 1, task_id: taskId, prompt_version: promptVersion, repetition_index: 1}, promptBytes: resolvedPrompt.bytes, promptSha256: resolvedPrompt.sha256, revisionProvenance: resolvedPrompt.revision_provenance, providerSnapshot: providerSnapshot(snapshot), inputSetSha256: sha256(canonicalBytes(projection)), outputSchemaSha256: sha256(fs.readFileSync(OUTPUT_SCHEMA_PATH))};
}

function buildArtifact(prepared, execution, evaluated, options = {}) {
  const lastAttempt = execution.attempts.at(-1) ?? {};
  const classification = execution.classification;
  const output = evaluated ?? {validation: {schema_validation: {status: 'NOT_RUN', error_codes: []}, authority_verification: {status: 'NOT_RUN', error_codes: []}, no_solver_verification: {status: 'NOT_RUN', error_codes: []}, canonicalization: {status: 'NOT_RUN', error_codes: []}, gold_comparison: {status: 'NOT_RUN', error_codes: []}, compiler_qualification: {status: 'NOT_RUN', error_codes: []}}, canonical_prediction: null, evaluator_result: {terminal_status: classification.status, planner_status: 'NOT_PARSED', schema_valid: false, semantic_valid: false, exact_requirement_set_match: false, capability_tp: 0, capability_fp: 0, capability_fn: prepared.seedCase.planner_document.capability_requirements.requirements.length, primary_errors: [classification.status], compiler_relation: 'NOT_RUN'}};
  const artifact = {
    artifact_version: 'planner-prototype-run-artifact-v0.1',
    run_identity: prepared.run,
    provenance: {planner_spec_commit: PLANNER_SPEC.commit, planner_spec_tag_object: PLANNER_SPEC.tag_object, planner_spec_tree: PLANNER_SPEC.tree, prototype_contract_commit: PROTOTYPE_CONTRACT.commit, prototype_contract_tag_object: PROTOTYPE_CONTRACT.tag_object, prototype_contract_tree: PROTOTYPE_CONTRACT.tree, prompt_sha256: prepared.promptSha256, input_set_sha256: prepared.inputSetSha256, output_schema_sha256: prepared.outputSchemaSha256, implementation_commit: options.implementationCommit ?? implementationCommit()},
    provider_snapshot: prepared.providerSnapshot,
    request: {request_sha256: execution.request_hash, reasoning_effort: 'none', temperature: 0, max_output_tokens: 4096, stream: false, attempt_count: execution.attempts.length},
    raw_prediction_text: classification.raw_output ?? null,
    raw_structured_prediction: classification.parsed_output ?? null,
    validation: output.validation,
    canonical_prediction: output.canonical_prediction,
    evaluator_result: output.evaluator_result
  };
  return artifact;
}

async function executePlannerRun(prepared, provider, options = {}) {
  if (!provider || typeof provider.send !== 'function') throw new Error('PLANNER_PROVIDER_REQUIRED');
  const assets = options.assets ?? loadPlannerAssets();
  const resolvedPrompt = resolveFrozenPlannerPrompt(prepared.run.prompt_version, assets);
  const expectedRequest = buildPlannerRequest(prepared.plannerInput, {assets, promptVersion: prepared.run.prompt_version});
  if (resolvedPrompt.sha256 !== prepared.promptSha256 || canonicalJson(expectedRequest) !== canonicalJson(prepared.request)) throw new Error(`${prepared.run.prompt_version === 'initial' ? 'INITIAL_PROMPT' : 'REVISED_PROMPT'}_CHANGED_BEFORE_DISPATCH`);
  const clock = options.clock ?? new FakeClock();
  const execution = await executeWithRetry({request: prepared.request, provider, runId: prepared.run.run_id, classify: (attempt) => classifyPlannerAttempt(attempt, assets), contract: options.transport ?? PLANNER_TRANSPORT, clock});
  const classification = execution.classification;
  let evaluated = null;
  if (classification.status === 'STRUCTURED_OUTPUT_VALID') evaluated = evaluatePlannerPrediction({plannerInput: prepared.plannerInput, seedCase: prepared.seedCase, prediction: classification.parsed_output, assets});
  return {artifact: buildArtifact(prepared, execution, evaluated, options), execution, evaluated};
}

async function runPlannerDevBatch({provider, experimentId = 'planner-dev-v0.1', promptVersion = 'initial', assets = loadPlannerAssets(), clockFactory = () => new FakeClock(), snapshot} = {}) {
  if (!provider) throw new Error('PLANNER_PROVIDER_REQUIRED');
  resolveFrozenPlannerPrompt(promptVersion, assets);
  const results = [];
  for (let caseIndex = 0; caseIndex < TASK_IDS.length; caseIndex += 1) {
    const prepared = preparePlannerRun({caseIndex, promptVersion, experimentId, assets, snapshot});
    results.push(await executePlannerRun(prepared, provider, {assets, clock: clockFactory()}));
  }
  return {results, summary: summarizePlannerBatch(results), input_set_sha256: results[0]?.artifact.provenance.input_set_sha256 ?? null};
}

function summarizePlannerBatch(results) {
  const statuses = {};
  for (const result of results) statuses[result.artifact.evaluator_result.terminal_status] = (statuses[result.artifact.evaluator_result.terminal_status] ?? 0) + 1;
  return {experiment_id: results[0]?.artifact.run_identity.experiment_id ?? null, total_runs: results.length, run_ids: results.map((result) => result.artifact.run_identity.run_id), status_counts: statuses, exact_count: results.filter((result) => result.artifact.evaluator_result.compiler_relation === 'ORACLE_EXACT').length, secret_scan_matches: scanSecrets(results)};
}

function scanSecrets(value) {
  const serialized = canonicalJson(value).toLowerCase();
  return ['api_key', 'authorization', 'bearer ', 'cookie', 'deepseek_api_key'].filter((needle) => serialized.includes(needle));
}

function opaqueGoldPrediction(seedCase, plannerInput, status = 'CONFIDENT') {
  const operationMapping = new Map(seedCase.planner_document.task_ir.operations.map((operation, index) => [operation.operation_id, SLOT_POOL[index]]));
  const taskIr = clone(seedCase.planner_document.task_ir);
  taskIr.operations.forEach((operation) => {
    operation.operation_id = operationMapping.get(operation.operation_id);
    operation.depends_on = operation.depends_on.map((dependency) => operationMapping.get(dependency));
  });
  const sources = plannerInput.authority_context.sources;
  const sourceFor = (requirement) => {
    const supportType = requirement.authority_witness.support_type;
    const supportRef = requirement.authority_witness.support_ref;
    return sources.find((source) => source.supports.some((support) => support.support_type === supportType && (support.support_ref === supportRef || supportRef === operationMapping.get(support.support_ref)))) ?? sources[0];
  };
  const requirements = clone(seedCase.planner_document.capability_requirements.requirements).map((requirement, index) => {
    requirement.requirement_id = `req.slot.${String(index + 1).padStart(3, '0')}`;
    requirement.operation_ref = operationMapping.get(requirement.operation_ref);
    const source = sourceFor(requirement);
    requirement.authority_witness.source_id = source.source_id;
    if (requirement.authority_witness.support_type === 'OPERATION') requirement.authority_witness.support_ref = requirement.operation_ref;
    return requirement;
  });
  return {status, task_ir: taskIr, requirements};
}

function initialBatchRecord(failureClassificationSha256) {
  if (!/^[0-9a-f]{64}$/.test(failureClassificationSha256)) throw new Error('FAILURE_CLASSIFICATION_HASH_INVALID');
  return {completed: true, run_ids: TASK_IDS.map((taskId, index) => `planner-dev-v0.1/initial/${String(index + 1).padStart(3, '0')}/${taskId}`), failure_classification_sha256: failureClassificationSha256};
}

function buildNoRevisionDecision(failureClassificationSha256) {
  return {contract_version: 'planner-prototype-contract-v0.1.2', decision: 'NO_REVISION', initial_prompt_sha256: INITIAL_PROMPT_SHA256, initial_batch: initialBatchRecord(failureClassificationSha256), general_revision_rationale: null, revised_prompt_sha256: null, prompt_diff_sha256: null, prompt_diff_format: null, revision_decided_after_initial_batch: true, revised_prompt_frozen_before_first_dispatch: null, revised_prompt_artifact: null, revision_admissibility: null, revised_batch: null};
}

function exactPromptDiffBytes(revisedPrompt) {
  return Buffer.from(JSON.stringify({format: 'planner-prompt-exact-diff-v0.1', initial_utf8_base64: readInitialPrompt().toString('base64'), revised_utf8_base64: Buffer.from(revisedPrompt).toString('base64')}), 'utf8');
}

function buildRevisionDenylist(assets = loadPlannerAssets()) {
  const values = [...TASK_IDS, ...assets.dev.cases.map((item) => item.case_id), ...assets.dev.cases.map((item) => item.planner_input.task.instruction), ...assets.dev.cases.flatMap((item) => item.planner_input.abstract_data_schema.fields.map((field) => field.field_ref)), ...assets.seeds.cases.flatMap((item) => item.planner_document.task_ir.operations.map((operation) => operation.operation_id)), ...assets.seeds.cases.flatMap((item) => item.planner_document.capability_requirements.requirements.map((requirement) => requirement.requirement_id))];
  return [...new Set(values)].sort();
}

function revisionAdmissible(revisedPrompt, rationale, assets = loadPlannerAssets()) {
  const prompt = Buffer.from(revisedPrompt);
  if (prompt.equals(readInitialPrompt())) return false;
  const texts = [prompt.toString('utf8').normalize('NFC').toLowerCase(), String(rationale).normalize('NFC').toLowerCase()];
  const denylist = buildRevisionDenylist(assets).map((value) => value.normalize('NFC').toLowerCase());
  return !texts.some((text) => denylist.some((value) => text.includes(value)) || /\b(eq|group|order|loc|cross|graph|tool)\s+(task|case)\b/i.test(text) || /\b(example\s*:|few[- ]?shot)\b/i.test(text) || /"task_ir"\s*:/i.test(text) && /"requirements"\s*:/i.test(text));
}

function revisedRunManifest(promptSha256) {
  return TASK_IDS.map((taskId, index) => ({
    run_id: `planner-dev-v0.1/revised/${String(index + 1).padStart(3, '0')}/${taskId}`,
    run_order: index + 1,
    task_id: taskId,
    prompt_version: 'revised',
    prompt_sha256: promptSha256
  }));
}

function buildOneGeneralRevisionDecision({failureClassificationSha256, revisedPrompt, rationale, assets = loadPlannerAssets()}) {
  const initialBatch = initialBatchRecord(failureClassificationSha256);
  const revisedBytes = Buffer.from(revisedPrompt);
  if (!revisionAdmissible(revisedBytes, rationale, assets)) throw new Error('REVISION_INADMISSIBLE');
  const promptSha256 = sha256(revisedBytes);
  const diffBytes = exactPromptDiffBytes(revisedBytes);
  const record = {
    contract_version: 'planner-prototype-contract-v0.1.2',
    decision: 'ONE_GENERAL_REVISION',
    initial_prompt_sha256: INITIAL_PROMPT_SHA256,
    initial_batch: initialBatch,
    general_revision_rationale: rationale,
    revised_prompt_sha256: promptSha256,
    prompt_diff_sha256: sha256(diffBytes),
    prompt_diff_format: 'planner-prompt-exact-diff-v0.1',
    revision_decided_after_initial_batch: true,
    revised_prompt_frozen_before_first_dispatch: true,
    revised_prompt_artifact: {
      path: 'prompts/planner-prototype-v0.1-revised.txt',
      diff_path: 'artifacts/planner-development/planner-prototype-v0.1-prompt-exact-diff.json'
    },
    revision_admissibility: {
      status: 'PASS',
      denylist_sha256: sha256(JSON.stringify(buildRevisionDenylist(assets))),
      zero_shot: true
    },
    revised_batch: {
      dispatch_policy: 'FULL_SEVEN_SERIAL_NO_SELECTIVE_RERUN',
      planned_runs: revisedRunManifest(promptSha256)
    }
  };
  const errors = schemaErrors(assets.revisionSchema, record);
  if (errors.length) throw new Error(`REVISION_RECORD_INVALID:${errors[0]}`);
  return {record, revisedPrompt: revisedBytes, diffBytes};
}

function revisedDispatchAllowed(record, revisedPrompt, diffBytes, nextRunIndex, priorPromptHashes, assets = loadPlannerAssets()) {
  const classificationBytes = fs.readFileSync(INITIAL_FAILURE_CLASSIFICATION_PATH);
  const gate = revisionProvenanceGate({record, classificationBytes, revisedPrompt: Buffer.from(revisedPrompt), diffBytes: Buffer.from(diffBytes), assets});
  if (!gate.ok || !record.revision_decided_after_initial_batch || !record.revised_prompt_frozen_before_first_dispatch) return false;
  const planned = record.revised_batch?.planned_runs ?? [];
  if (planned.length !== 7 || planned.some((run, index) => run.run_id !== `planner-dev-v0.1/revised/${String(index + 1).padStart(3, '0')}/${TASK_IDS[index]}` || run.run_order !== index + 1 || run.task_id !== TASK_IDS[index] || run.prompt_version !== 'revised' || run.prompt_sha256 !== record.revised_prompt_sha256)) return false;
  return nextRunIndex === priorPromptHashes.length && nextRunIndex >= 0 && nextRunIndex < 7 && priorPromptHashes.every((hash) => hash === record.revised_prompt_sha256) && planned[nextRunIndex].prompt_sha256 === record.revised_prompt_sha256;
}

function writePlannerArtifact(filePath, artifact, assets = loadPlannerAssets()) {
  if (schemaErrors(assets.artifactSchema, artifact).length) throw new Error('PLANNER_ARTIFACT_SCHEMA_INVALID');
  if (scanSecrets(artifact).length) throw new Error('PLANNER_ARTIFACT_SECRET_SCAN_FAILED');
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, {flag: 'wx'});
  return filePath;
}

function verifyFrozenIntegrity() {
  const prompt = readInitialPrompt();
  const refs = [['planner-spec-v0.2.1^{commit}', PLANNER_SPEC.commit], ['planner-spec-v0.2.1^{tag}', PLANNER_SPEC.tag_object], ['planner-spec-v0.2.1^{tree}', PLANNER_SPEC.tree], ['planner-prototype-contract-v0.1.2^{commit}', PROTOTYPE_CONTRACT.commit], ['planner-prototype-contract-v0.1.2^{tag}', PROTOTYPE_CONTRACT.tag_object], ['planner-prototype-contract-v0.1.2^{tree}', PROTOTYPE_CONTRACT.tree], ['planner-prototype-contract-v0.1.1^{commit}', P0_CONTRACT.commit], ['planner-prototype-contract-v0.1.1^{tag}', P0_CONTRACT.tag_object], ['planner-prototype-contract-v0.1.1^{tree}', P0_CONTRACT.tree]];
  const mismatches = refs.filter(([ref, expected]) => { try { return childProcess.execFileSync('git', ['rev-parse', ref], {cwd: ROOT, encoding: 'utf8'}).trim() !== expected; } catch { return true; } }).map(([ref]) => ref);
  return {prompt_sha256: sha256(prompt), prompt_ok: sha256(prompt) === INITIAL_PROMPT_SHA256, mismatches, ok: mismatches.length === 0 && sha256(prompt) === INITIAL_PROMPT_SHA256};
}

function p0ProjectionRegression(assets = loadPlannerAssets()) {
  const projection = buildProviderVisibleProjection(assets.dev);
  const serialized = projection.map((item) => canonicalJson(item));
  const oldIdentifiers = new Set(readJson(path.join(ROOT, 'fixtures', 'planner-prototype-dev-cases-v0.1.json')).cases.flatMap((item) => [item.planner_input.abstract_data_schema.schema_id, ...item.planner_input.authority_context.sources.map((source) => source.source_id)]));
  const goldOperationIds = new Set(assets.seeds.cases.flatMap((item) => item.planner_document.task_ir.operations.map((operation) => operation.operation_id)));
  const leakStrings = [...oldIdentifiers, ...goldOperationIds, ...TASK_IDS];
  const slotPools = projection.map((item) => item.operation_slot_policy.slots);
  const intentPools = projection.map((item) => item.authority_context.sources.find((source) => source.authority_class === 'USER_INTENT')?.supports);
  const result = {case_count: projection.length, semantic_task_ids: serialized.reduce((n, text) => n + TASK_IDS.filter((id) => text.includes(id)).length, 0), gold_operation_ids: serialized.reduce((n, text) => n + [...goldOperationIds].filter((id) => text.includes(id)).length, 0), semantic_schema_context_ids: serialized.reduce((n, text) => n + [...oldIdentifiers].filter((id) => text.includes(id)).length, 0), gold_oracle_evaluator_objects: serialized.reduce((n, text) => n + ['oracle_bridge', 'ground_truth', 'evaluator_task_id', 'case_id'].filter((id) => text.includes(id)).length, 0), operation_slot_pool_identical: slotPools.every((pool) => canonicalJson(pool) === canonicalJson(slotPools[0])), user_intent_pool_identical: intentPools.every((pool) => canonicalJson(pool) === canonicalJson(intentPools[0]))};
  result.pass = result.case_count === 7 && result.semantic_task_ids === 0 && result.gold_operation_ids === 0 && result.semantic_schema_context_ids === 0 && result.gold_oracle_evaluator_objects === 0 && result.operation_slot_pool_identical && result.user_intent_pool_identical;
  return result;
}

function qualificationScenarios(assets = loadPlannerAssets()) {
  const scenarios = [];
  for (let index = 0; index < 7; index += 1) {
    const input = buildProviderVisibleProjection(assets.dev)[index];
    scenarios.push({name: `${TASK_IDS[index]}_VALID`, input, seedCase: assets.seeds.cases[index], prediction: opaqueGoldPrediction(assets.seeds.cases[index], input)});
  }
  scenarios.push({name: 'UNCERTAIN', input: buildProviderVisibleProjection(assets.dev)[0], seedCase: assets.seeds.cases[0], prediction: opaqueGoldPrediction(assets.seeds.cases[0], buildProviderVisibleProjection(assets.dev)[0], 'UNCERTAIN')});
  scenarios.push({name: 'INVALID_STATUS', input: buildProviderVisibleProjection(assets.dev)[0], seedCase: assets.seeds.cases[0], prediction: {status: 'INVALID', task_ir: null, requirements: []}});
  return scenarios;
}

async function runOfflineQualification({assets = loadPlannerAssets()} = {}) {
  const regression = p0ProjectionRegression(assets);
  if (!regression.pass) throw new Error('P0_PROJECTION_REGRESSION_FAILED');
  const scenarios = qualificationScenarios(assets);
  const validScripts = new Map();
  for (let index = 0; index < 7; index += 1) {
    const scenario = scenarios[index];
    validScripts.set(`planner-dev-v0.1/initial/${String(index + 1).padStart(3, '0')}/${TASK_IDS[index]}`, [{http_status: 200, latency_ms: 1, response: {status: 'completed', model: 'deepseek-flash', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(scenario.prediction)}]}]}}]);
  }
  const provider = new FakeProvider(validScripts);
  const batch = await runPlannerDevBatch({provider, assets, clockFactory: () => new FakeClock()});
  const direct = scenarios.map((scenario) => evaluatePlannerPrediction({plannerInput: scenario.input, seedCase: scenario.seedCase, prediction: scenario.prediction, assets}));
  const failureClassification = sha256(direct.map((item) => item.evaluator_result));
  const decision = buildNoRevisionDecision(failureClassification);
  return {status: 'offline_qualification', network_used: false, regression, batch, scenario_count: direct.length, valid_count: direct.filter((item) => item.evaluator_result.compiler_relation === 'ORACLE_EXACT').length, no_revision: decision, frozen_integrity: verifyFrozenIntegrity(), secret_scan_matches: scanSecrets({batch, decision})};
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--offline-qualification') throw new Error('usage: node src/planner-prototype-v0.1.2.js --offline-qualification');
  runOfflineQualification().then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}

module.exports = {
  ARTIFACT_SCHEMA_PATH, CATALOG_PATH, CONTRACT_PATH, DEV_PATH, INITIAL_PROMPT_SHA256,
  INITIAL_FAILURE_CLASSIFICATION_SHA256, INPUT_SCHEMA_PATH, OUTPUT_SCHEMA_PATH, PLANNER_SPEC, PLANNER_TRANSPORT,
  PROTOTYPE_CONTRACT, PROMPT_PATH, P0_CONTRACT, REVISION_SCHEMA_PATH, SEEDS_PATH,
  INITIAL_FAILURE_CLASSIFICATION_PATH, PROMPT_DIFF_PATH, PROMPT_DIFF_SHA256, REVISED_PROMPT_PATH, REVISED_PROMPT_SHA256, REVISION_DECISION_PATH, REVISION_FREEZE_COMMIT,
  FakeClock, FakeProvider,
  SLOT_POOL, TASK_IDS, TRUSTED_AUTHORITY, alphaCanonical, buildArtifact,
  buildNoRevisionDecision, buildOneGeneralRevisionDecision, buildPlannerRequest, buildProviderVisibleProjection,
  buildRevisionDenylist, canonicalBytes, canonicalizePrediction, canonicalJson,
  capabilityMetrics, canonicalRequirementSet, classifyPlannerAttempt, clone, compareGold, compilePrediction, evaluatePlannerPrediction,
  exactPromptDiffBytes, executePlannerRun, implementationCommit, initialBatchRecord,
  loadPlannerAssets, noSolverError, opaqueGoldPrediction, p0ProjectionRegression,
  preparePlannerRun, providerSnapshot, readInitialPrompt, resolveFrozenPlannerPrompt, revisionAdmissible, revisionProvenanceGate,
  revisedDispatchAllowed, runOfflineQualification, runPlannerDevBatch, scanSecrets, schemaErrors, sha256, unsafeEvaluation,
  validateSchema,
  slotPolicyError, summarizePlannerBatch, validatePlannerInput, validatePrediction,
  verifyAuthority, verifyFrozenIntegrity, verifyNoSolver, writePlannerArtifact
};
