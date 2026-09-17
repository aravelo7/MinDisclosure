'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const {STRATEGIES, TASK_IDS} = require('./constants');
const {evaluateOutput, projectOracleCase} = require('./oracle');
const {loadSearchSpace, searchAllOraclePlans} = require('./oracle-search');
const {projectSolverCase, solveTask} = require('./solver');
const {emptyCategoryCounts, projectTransformationCase, transformTask} = require('./transformer');
const {loadFixture} = require('./md-bench-v0.2');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'docs', 'llm-experiment-contract-v0.1.md');
const SCHEMA_PATH = path.join(ROOT, 'fixtures', 'llm-output-schemas-v0.1.json');
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'md-bench-v0.2.json');
const FROZEN_BENCHMARK_COMMIT = '932f16e2ccf4dab64995f11a70a054ae19b52b04';
const DEFAULT_EXPERIMENT_ID = 'md-bench-v0.2-deepseek-flash-contract-v0.1-offline-validation';
const DEEPSEEK_RESPONSES_URL = 'https://api.deepseek.com/responses';
const RANDOMIZATION_SEED = 'md-bench-v0.2-llm-contract-v0.1-seed-20260916';
const MAX_OUTPUT_TOKENS = 256;
const RUN_ORDER_ALGORITHM_VERSION = 'balanced-williams-blocks-v0.1';
const STRATEGY_SYMBOLS = {
  A: 'FIXED_REDACTION',
  B: 'STABLE_TOKENIZATION',
  C: 'ORACLE_MIN_DISCLOSURE',
  D: 'RAW_DISCLOSURE'
};
const LATIN_ROWS = [
  ['A', 'B', 'D', 'C'],
  ['B', 'C', 'A', 'D'],
  ['C', 'D', 'B', 'A'],
  ['D', 'A', 'C', 'B']
];
const TRANSPORT_CONTRACT = Object.freeze({
  concurrency: 1,
  sdk_auto_retries: 0,
  connect_timeout_ms: 5_000,
  attempt_timeout_ms: 180_000,
  whole_run_wall_timeout_ms: 480_000,
  max_retries: 1,
  retry_429_without_header_ms: 3_000,
  retry_500_503_ms: 1_000,
  retry_connection_failure_ms: 1_000,
  retry_attempt_timeout_ms: 1_000,
  retry_after_max_ms: 120_000,
  jitter: false
});
const INSTRUCTIONS = [
  'Complete the provided task using only the provided input data.',
  'Return only the structured result. Do not explain your reasoning.'
].join(' ');
const RENDERER_CONTRACT = {
  version: 'strategy-blind-renderer-v0.1',
  instructions: INSTRUCTIONS,
  input_sections: ['Task', 'Input data'],
  input_serialization: 'canonical-json',
  forbidden_metadata: ['strategy', 'representation', 'exposure', 'privacy', 'ground_truth', 'oracle']
};
const STATUSES = [
  'COMPLETED_CORRECT',
  'COMPLETED_INCORRECT',
  'INVALID_OUTPUT',
  'INCOMPLETE_OUTPUT',
  'PROVIDER_FAILED',
  'REQUEST_INVALID',
  'AUTH_FAILED',
  'BALANCE_FAILED'
];
const RETRYABLE_HTTP = new Set([429, 500, 503]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function loadSchemas() {
  const document = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  if (document.contract_version !== 'llm-experiment-contract-v0.1') throw new Error('schema contract mismatch');
  if (canonicalJson(Object.keys(document.schemas).sort()) !== canonicalJson([...TASK_IDS].sort())) {
    throw new Error('schema task set mismatch');
  }
  return document.schemas;
}

function validateAgainstSchema(schema, value, at = '$') {
  if (schema.const !== undefined && value !== schema.const) return `${at}: const mismatch`;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at}: expected object`;
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return `${at}: missing ${required}`;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      const extra = keys.find((key) => !allowed.has(key));
      if (extra) return `${at}: unexpected ${extra}`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        const error = validateAgainstSchema(child, value[key], `${at}.${key}`);
        if (error) return error;
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at}: expected array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${at}: too few items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at}: too many items`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateAgainstSchema(schema.items, value[index], `${at}[${index}]`);
      if (error) return error;
    }
  } else if (schema.type === 'string' && typeof value !== 'string') return `${at}: expected string`;
  else if (schema.type === 'number' && typeof value !== 'number') return `${at}: expected number`;
  else if (schema.type === 'integer' && !Number.isInteger(value)) return `${at}: expected integer`;
  return null;
}

function projectLlmCase(task, transformed) {
  return {
    task_id: task.task_id,
    user_instruction: task.user_instruction,
    agent_input: JSON.parse(JSON.stringify(transformed.agent_input))
  };
}

function renderLlmCase(llmCase) {
  if (canonicalJson(Object.keys(llmCase).sort()) !== canonicalJson(['agent_input', 'task_id', 'user_instruction'])) {
    throw new Error('renderer received data outside the safe LLM projection');
  }
  return {
    instructions: INSTRUCTIONS,
    input: `Task:\n${llmCase.user_instruction}\n\nInput data:\n${canonicalJson(llmCase.agent_input)}`
  };
}

function schemaName(taskId) {
  return `min_disclosure_${taskId.toLowerCase().replace(/-/g, '_')}_v0_1`;
}

function buildRequest(rendered, taskId, schemas = loadSchemas()) {
  return {
    model: 'deepseek-flash',
    instructions: rendered.instructions,
    input: rendered.input,
    reasoning: {effort: 'none'},
    temperature: 0,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
    text: {
      format: {
        type: 'json_schema',
        name: schemaName(taskId),
        schema: schemas[taskId]
      }
    }
  };
}

function deterministicTaskOrder(taskIds, repetitionIndex, seed = RANDOMIZATION_SEED) {
  return [...taskIds].sort((left, right) => {
    const leftKey = sha256(`${seed}/rep/${repetitionIndex}/${left}`);
    const rightKey = sha256(`${seed}/rep/${repetitionIndex}/${right}`);
    return leftKey.localeCompare(rightKey) || left.localeCompare(right);
  });
}

function deterministicOrder(taskIds = TASK_IDS, repetitions = 5, seed = RANDOMIZATION_SEED) {
  const runs = [];
  for (let repetitionIndex = 0; repetitionIndex < repetitions; repetitionIndex += 1) {
    const taskOrder = deterministicTaskOrder(taskIds, repetitionIndex, seed);
    for (const taskId of taskOrder) {
      const taskIndex = taskIds.indexOf(taskId);
      const latinRowIndex = (taskIndex + repetitionIndex) % LATIN_ROWS.length;
      const strategyOrder = LATIN_ROWS[latinRowIndex].map((symbol) => STRATEGY_SYMBOLS[symbol]);
      for (let strategyPosition = 0; strategyPosition < strategyOrder.length; strategyPosition += 1) {
        runs.push({
          task_id: taskId,
          strategy: strategyOrder[strategyPosition],
          repetition_index: repetitionIndex + 1,
          block_id: `rep-${repetitionIndex + 1}/${taskId}`,
          latin_row_index: latinRowIndex,
          strategy_position: strategyPosition + 1
        });
      }
    }
  }
  return runs;
}


function withSelfHash(object, field) {
  const copy = JSON.parse(JSON.stringify(object));
  delete copy[field];
  return {...copy, [field]: sha256(copy)};
}

function buildManifest(options = {}) {
  const repetitions = 5;
  const runs = deterministicOrder(TASK_IDS, repetitions, RANDOMIZATION_SEED).map((run, index) => ({
    run_id: `run-${String(index + 1).padStart(3, '0')}`,
    run_order: index + 1,
    ...run
  }));
  const schemas = loadSchemas();
  const contractBytes = fs.readFileSync(CONTRACT_PATH);
  const schemaBytes = fs.readFileSync(SCHEMA_PATH);
  const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
  const manifest = {
    experiment_contract_version: 'llm-experiment-contract-v0.1',
    experiment_id: options.experimentId ?? DEFAULT_EXPERIMENT_ID,
    execution_mode: 'offline_mock_harness_validation',
    formal_experiment_started: false,
    execution_type: 'offline_mock',
    model_invoked: false,
    research_result: false,
    contract: {
      document: 'docs/llm-experiment-contract-v0.1.md',
      document_sha256: sha256(contractBytes)
    },
    benchmark: {
      version: 'md-bench-v0.2',
      tag: 'md-bench-v0.2',
      commit: options.benchmarkCommit ?? FROZEN_BENCHMARK_COMMIT,
      fixture_sha256: sha256(fixtureBytes)
    },
    provider: {
      name: 'DeepSeek',
      api_surface: 'POST /responses',
      requested_model: 'deepseek-flash',
      documented_serving_model: 'DeepSeek-V4.1-Flash',
      provider_docs_checked_at: '2026-09-16T00:00:00Z',
      model_alias_mutable: true,
      provider_doc_notes: [
        'deepseek-flash was documented as serving DeepSeek-V4.1-Flash at calibration time.',
        'Models & Pricing described deepseek-v4-pro as routing to V4.1 Flash after 2026-09-14, while the Change Log described continued V4 Pro service; Pro is excluded from this experiment.'
      ]
    },
    request_contract: {
      reasoning: {effort: 'none'},
      temperature: 0,
      top_p: 'omitted',
      max_output_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
      tools: 'omitted',
      tool_choice: 'omitted',
      user: 'omitted',
      previous_response_id: 'omitted',
      conversation_state: 'omitted',
      structured_output: 'text.format.type=json_schema'
    },
    execution_contract: {
      repetitions,
      repetition_purpose: 'characterization of residual run-to-run instability',
      independent_task_count: TASK_IDS.length,
      total_runs: runs.length,
      topology: 'serial',
      concurrency: TRANSPORT_CONTRACT.concurrency,
      run_order: {
        algorithm_version: RUN_ORDER_ALGORITHM_VERSION,
        run_order_seed: RANDOMIZATION_SEED,
        canonical_task_order: [...TASK_IDS],
        strategy_symbols: STRATEGY_SYMBOLS,
        latin_rows: LATIN_ROWS,
        task_order: 'SHA-256 keyed deterministic ordering per repetition',
        block: 'task x repetition; four strategies emitted contiguously'
      },
      transport: TRANSPORT_CONTRACT,
      timeout_semantics: 'connect_timeout_ms is a TCP/TLS phase limit inside, not additional to, attempt_timeout_ms; whole_run_wall_timeout_ms covers attempts and waits',
      max_attempts_per_run: TRANSPORT_CONTRACT.max_retries + 1,
      retryable_http_statuses: [...RETRYABLE_HTTP],
      retryable_transport_failure: ['connection_failure', 'attempt_timeout'],
      retry_owner: 'harness-only',
      attempt_count_semantics: 'attempts.length; pre-request validation does not count',
      model_output_retry: false,
      invalid_output_repair: 'none'
    },
    renderer: {
      version: RENDERER_CONTRACT.version,
      sha256: sha256(RENDERER_CONTRACT)
    },
    schemas: {
      source: 'fixtures/llm-output-schemas-v0.1.json',
      document_sha256: sha256(schemaBytes),
      set_sha256: sha256(schemas),
      per_task_sha256: Object.fromEntries(TASK_IDS.map((taskId) => [taskId, sha256(schemas[taskId])]))
    },
    runs
  };
  return withSelfHash(manifest, 'manifest_sha256');
}

function responseText(response) {
  if (!response || !Array.isArray(response.output)) return null;
  const parts = response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text);
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : null;
}

function classifyAttempt(attempt, taskId, schema) {
  const http = attempt.http_status;
  if (http === 400 || http === 422) return {terminal: true, status: 'REQUEST_INVALID'};
  if (http === 401) return {terminal: true, status: 'AUTH_FAILED'};
  if (http === 402) return {terminal: true, status: 'BALANCE_FAILED'};
  if (attempt.transport_failure && !attempt.response) return {terminal: false, retryable: true, status: 'PROVIDER_FAILED'};
  if (RETRYABLE_HTTP.has(http) && !attempt.response) return {terminal: false, retryable: true, status: 'PROVIDER_FAILED'};
  if (http !== 200 || !attempt.response) return {terminal: true, status: 'PROVIDER_FAILED'};
  if (attempt.response.status === 'incomplete') return {terminal: true, status: 'INCOMPLETE_OUTPUT'};
  if (attempt.response.status === 'failed') return {terminal: true, status: 'PROVIDER_FAILED'};
  if (attempt.response.status !== 'completed') return {terminal: true, status: 'PROVIDER_FAILED'};
  const rawOutput = responseText(attempt.response);
  if (!rawOutput) return {terminal: true, status: 'INVALID_OUTPUT', raw_output: rawOutput, schema_status: 'empty'};
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    return {terminal: true, status: 'INVALID_OUTPUT', raw_output: rawOutput,
      schema_status: 'json_parse_failed', schema_error: error.message};
  }
  const schemaError = validateAgainstSchema(schema, parsed);
  if (schemaError) return {terminal: true, status: 'INVALID_OUTPUT', raw_output: rawOutput,
    parsed_output: parsed, schema_status: 'schema_invalid', schema_error: schemaError};
  return {terminal: true, status: 'STRUCTURED_OUTPUT_VALID', raw_output: rawOutput,
    parsed_output: parsed, schema_status: 'valid'};
}

function summarizeBoundary(ledger, boundary) {
  const items = ledger.filter((entry) => entry.boundary === boundary);
  const categoryCounts = emptyCategoryCounts();
  for (const item of items) categoryCounts[item.representation] += 1;
  return {
    category_counts: categoryCounts,
    raw_exposure_count: items.filter((entry) => entry.representation === 'RAW_VALUE').length,
    exposure_score: items.reduce((sum, entry) => sum + entry.exposure_weight, 0)
  };
}

class FakeProvider {
  constructor(scripts) {
    this.scripts = scripts;
    this.calls = [];
  }

  async send(request, context) {
    const scripted = this.scripts.get(context.run_id);
    const index = context.attempt_index - 1;
    if (!scripted || !scripted[index]) throw new Error(`missing fake attempt for ${context.run_id}/${context.attempt_index}`);
    this.calls.push({run_id: context.run_id, attempt_index: context.attempt_index, request: JSON.parse(JSON.stringify(request))});
    return JSON.parse(JSON.stringify(scripted[index]));
  }
}

class FakeClock {
  constructor(startMs = 0) {
    this.is_virtual = true;
    this.current_ms = startMs;
    this.sleeps = [];
  }

  now() { return this.current_ms; }

  advance(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('invalid fake-clock advance');
    this.current_ms += milliseconds;
  }

  async sleep(milliseconds) {
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
  }
}

class RealClock {
  constructor() { this.sleeps = []; }
  now() { return Date.now(); }
  async sleep(milliseconds) {
    this.sleeps.push(milliseconds);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

function responseHeaderSubset(headers) {
  return Object.fromEntries(['content-type', 'retry-after', 'x-request-id', 'request-id']
    .filter((name) => headers[name] !== undefined)
    .map((name) => [name, headers[name]]));
}

function transportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dispatchHttpsJson({url, body, authorization, connectTimeoutMs, attemptTimeoutMs, requestImpl = https.request}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let connectTimer;
    let attemptTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(attemptTimer);
      resolve({...value, latency_ms: Date.now() - started});
    };
    const payload = Buffer.from(body, 'utf8');
    const request = requestImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization
      }
    }, (response) => {
      clearTimeout(connectTimer);
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        let parseError = null;
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          parseError = {code: 'INVALID_JSON_RESPONSE', message: 'Provider response body was not valid JSON'};
        }
        const status = response.statusCode ?? null;
        const providerError = status === 200 ? null : (parsed?.error ?? null);
        finish({
          http_status: status,
          response_headers: responseHeaderSubset(response.headers),
          retry_after: response.headers['retry-after'] ?? null,
          response_body_sha256: sha256(rawBody),
          response: status === 200 ? parsed : null,
          provider_error: providerError,
          transport_failure: false,
          error: parseError ?? (status === 200 ? null : {
            code: providerError?.code ?? `HTTP_${status}`,
            message: providerError?.message ?? `Provider returned HTTP ${status}`
          })
        });
      });
    });
    request.once('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once('secureConnect', () => clearTimeout(connectTimer));
    });
    request.once('error', (error) => {
      const kind = error.code === 'ATTEMPT_TIMEOUT' ? 'attempt_timeout' : 'connection_failure';
      finish({http_status: null, response_headers: {}, retry_after: null, response_body_sha256: null,
        response: null, provider_error: null, transport_failure: kind,
        error: {code: error.code ?? 'CONNECTION_FAILURE', message: kind === 'attempt_timeout'
          ? 'HTTP attempt exceeded the frozen total timeout'
          : 'HTTP request failed before a classifiable response'}});
    });
    connectTimer = setTimeout(() => request.destroy(transportError('CONNECT_TIMEOUT', 'connect timeout')),
      connectTimeoutMs);
    attemptTimer = setTimeout(() => request.destroy(transportError('ATTEMPT_TIMEOUT', 'attempt timeout')),
      attemptTimeoutMs);
    request.end(payload);
  });
}

class DeepSeekResponsesAdapter {
  constructor(options = {}) {
    const sdkAutoRetries = options.sdkAutoRetries ?? 0;
    if (sdkAutoRetries !== 0) throw new Error('SDK_AUTO_RETRIES_MUST_BE_ZERO');
    this.sdk_auto_retries = 0;
    this.endpoint = options.endpoint ?? DEEPSEEK_RESPONSES_URL;
    this.request_impl = options.requestImpl ?? https.request;
    this.credential_env = 'DEEPSEEK_API_KEY';
    this.dispatch_count = 0;
  }

  async send(request, context = {}) {
    if (!context.attempt_record || !Object.isFrozen(context.attempt_record)) {
      throw new Error('AUDITABLE_ATTEMPT_RECORD_REQUIRED');
    }
    const apiKey = process.env[this.credential_env];
    if (!apiKey) throw new Error('MISSING_DEEPSEEK_API_KEY');
    this.dispatch_count += 1;
    return dispatchHttpsJson({
      url: this.endpoint,
      body: canonicalJson(request),
      authorization: `Bearer ${apiKey}`,
      connectTimeoutMs: TRANSPORT_CONTRACT.connect_timeout_ms,
      attemptTimeoutMs: TRANSPORT_CONTRACT.attempt_timeout_ms,
      requestImpl: this.request_impl
    });
  }
}

function completedAttempt(output, suffix, overrides = {}) {
  return {
    http_status: 200,
    latency_ms: 25,
    response: {
      id: `resp_mock_${suffix}`,
      created_at: 1789574400,
      status: 'completed',
      model: 'deepseek-flash',
      output: [{type: 'message', status: 'completed', content: [{type: 'output_text', text: output}]}],
      usage: {input_tokens: 100, input_tokens_details: {cached_tokens: 0}, output_tokens: 30,
        output_tokens_details: {reasoning_tokens: 0}, total_tokens: 130},
      error: null,
      incomplete_details: null
    },
    ...overrides
  };
}

function retryableAttempt(httpStatus, overrides = {}) {
  return {http_status: httpStatus, latency_ms: 10, response: null, transport_failure: false,
    error: {code: `HTTP_${httpStatus}`, message: 'scripted transient failure'}, ...overrides};
}

function transportFailureAttempt(kind, overrides = {}) {
  return {http_status: null, latency_ms: 10, response: null, transport_failure: kind,
    error: {code: kind.toUpperCase(), message: `scripted ${kind}`}, ...overrides};
}

function parseRetryAfter(raw, nowMs) {
  if (raw === undefined || raw === null || raw === '') return {kind: 'absent', wait_ms: null};
  const text = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Math.ceil(Number(text) * 1000);
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? {kind: 'valid', wait_ms: milliseconds}
      : {kind: 'invalid', wait_ms: null};
  }
  const timestamp = Date.parse(text);
  if (!Number.isNaN(timestamp) && timestamp > nowMs) return {kind: 'valid', wait_ms: timestamp - nowMs};
  return {kind: 'invalid', wait_ms: null};
}

function retryDecision(attempt, elapsedMs, contract = TRANSPORT_CONTRACT, nowMs = 0) {
  let waitMs;
  let source;
  if (attempt.http_status === 429) {
    const parsed = parseRetryAfter(attempt.retry_after, nowMs);
    if (parsed.kind === 'invalid') return {retry: false, reason: 'INVALID_RETRY_AFTER'};
    if (parsed.kind === 'valid') {
      if (parsed.wait_ms > contract.retry_after_max_ms) {
        return {retry: false, reason: 'RETRY_AFTER_EXCEEDS_CAP', retry_after_ms: parsed.wait_ms};
      }
      waitMs = parsed.wait_ms;
      source = 'retry-after';
    } else {
      waitMs = contract.retry_429_without_header_ms;
      source = 'default-429';
    }
  } else if (attempt.http_status === 500 || attempt.http_status === 503) {
    waitMs = contract.retry_500_503_ms;
    source = `default-${attempt.http_status}`;
  } else if (attempt.transport_failure === 'connection_failure') {
    waitMs = contract.retry_connection_failure_ms;
    source = 'default-connection-failure';
  } else if (attempt.transport_failure === 'attempt_timeout') {
    waitMs = contract.retry_attempt_timeout_ms;
    source = 'default-attempt-timeout';
  } else {
    return {retry: false, reason: 'NOT_RETRYABLE'};
  }
  const remainingMs = contract.whole_run_wall_timeout_ms - elapsedMs;
  if (remainingMs <= waitMs + contract.attempt_timeout_ms) {
    return {retry: false, reason: 'INSUFFICIENT_RUN_WALL_BUDGET_FOR_RETRY', wait_ms: waitMs,
      wait_source: source, remaining_ms: remainingMs};
  }
  return {retry: true, reason: 'RETRY_ALLOWED', wait_ms: waitMs, wait_source: source,
    remaining_ms: remainingMs};
}

function incorrectOutput(taskId) {
  switch (taskId) {
    case 'MD-EQ-01': return {duplicate_groups: []};
    case 'MD-GROUP-02': return {groups: []};
    case 'MD-ORDER-03': return {ordered_record_ids: []};
    case 'MD-LOC-04': return {zone_summaries: []};
    case 'MD-CROSS-05': return {event_pairs: []};
    case 'MD-GRAPH-06': return {out_degree: [], reachable_from_n1_in_two_hops: []};
    case 'MD-TOOL-07': return {tool: 'dispatch_visit', arguments: {ticket_id: 't1', recipient: '<E_001>', service_zone: 'NORTH'}};
    default: throw new Error(`unknown task ${taskId}`);
  }
}

function buildPreparedRuns(fixture, manifest) {
  const searches = searchAllOraclePlans(fixture);
  const searchByTask = new Map(searches.map((item) => [item.task_id, item]));
  const schemas = loadSchemas();
  return manifest.runs.map((run) => {
    const task = fixture.tasks.find((item) => item.task_id === run.task_id);
    const plan = run.strategy === 'ORACLE_MIN_DISCLOSURE'
      ? searchByTask.get(run.task_id).selected_plan
      : task.oracle_disclosure_plan;
    const transformed = transformTask(
      {exposure_weights: fixture.exposure_weights},
      projectTransformationCase(task, plan),
      run.strategy
    );
    const llmCase = projectLlmCase(task, transformed);
    const rendered = renderLlmCase(llmCase);
    const request = buildRequest(rendered, task.task_id, schemas);
    return {run, task, transformed, rendered, request, schema: schemas[task.task_id]};
  });
}

function buildMockScripts(prepared) {
  const scripts = new Map();
  for (const item of prepared) {
    const output = solveTask(projectSolverCase(item.task, item.transformed));
    scripts.set(item.run.run_id, [completedAttempt(JSON.stringify(output), item.run.run_id)]);
  }
  const nonTool = prepared.filter((item) => item.run.task_id !== 'MD-TOOL-07');
  scripts.set(nonTool[0].run.run_id, [completedAttempt(JSON.stringify(incorrectOutput(nonTool[0].run.task_id)), 'incorrect')]);
  scripts.set(nonTool[1].run.run_id, [completedAttempt('{not-json', 'malformed')]);
  scripts.set(nonTool[2].run.run_id, [{http_status: 200, latency_ms: 25, response: {
    id: 'resp_mock_incomplete', created_at: 1789574400, status: 'incomplete', model: 'deepseek-flash', output: [],
    usage: {input_tokens: 100, output_tokens: 256, total_tokens: 356}, error: null,
    incomplete_details: {reason: 'max_output_tokens'}}}]);
  scripts.set(nonTool[3].run.run_id, [{http_status: 200, latency_ms: 25, response: {
    id: 'resp_mock_filtered', created_at: 1789574400, status: 'incomplete', model: 'deepseek-flash', output: [],
    usage: {input_tokens: 100, output_tokens: 0, total_tokens: 100}, error: null,
    incomplete_details: {reason: 'content_filter'}}}]);
  const solved = (index, suffix) => completedAttempt(JSON.stringify(
    solveTask(projectSolverCase(nonTool[index].task, nonTool[index].transformed))), suffix);
  scripts.set(nonTool[4].run.run_id, [retryableAttempt(429, {retry_after: '2'}), solved(4, 'retry429header')]);
  scripts.set(nonTool[5].run.run_id, [retryableAttempt(429), solved(5, 'retry429default')]);
  scripts.set(nonTool[6].run.run_id, [retryableAttempt(429, {retry_after: '121'})]);
  scripts.set(nonTool[7].run.run_id, [retryableAttempt(500), solved(7, 'retry500')]);
  scripts.set(nonTool[8].run.run_id, [retryableAttempt(503), retryableAttempt(503)]);
  scripts.set(nonTool[9].run.run_id, [transportFailureAttempt('connection_failure'), solved(9, 'retryconnection')]);
  scripts.set(nonTool[10].run.run_id, [transportFailureAttempt('attempt_timeout', {latency_ms: 180000}),
    solved(10, 'retrytimeout')]);
  scripts.set(nonTool[11].run.run_id, [retryableAttempt(429, {retry_after: '120', latency_ms: 180000})]);
  scripts.set(nonTool[12].run.run_id, [{http_status: 400, latency_ms: 8, response: null,
    error: {code: 'invalid_request', message: 'scripted invalid request'}}]);
  scripts.set(nonTool[13].run.run_id, [{http_status: 401, latency_ms: 8, response: null,
    error: {code: 'auth_failed', message: 'scripted auth failure'}}]);
  scripts.set(nonTool[14].run.run_id, [{http_status: 402, latency_ms: 8, response: null,
    error: {code: 'balance_failed', message: 'scripted balance failure'}}]);
  scripts.set(nonTool[15].run.run_id, [{http_status: 422, latency_ms: 8, response: null,
    error: {code: 'invalid_request', message: 'scripted semantic request failure'}}]);
  scripts.set(nonTool[16].run.run_id, [{http_status: 200, latency_ms: 20, response: {
    id: 'resp_mock_failed', created_at: 1789574400, status: 'failed', model: 'deepseek-flash', output: [],
    usage: null, error: {code: 'provider_failed', message: 'scripted provider failure'}, incomplete_details: null}}]);
  const tool = prepared.find((item) => item.run.task_id === 'MD-TOOL-07' && item.run.strategy === 'STABLE_TOKENIZATION');
  scripts.set(tool.run.run_id, [completedAttempt(JSON.stringify({
    tool: 'dispatch_visit', arguments: {ticket_id: 't2', recipient: '<E_003>', service_zone: 'NORTH'}
  }), 'wrongtool')]);
  return scripts;
}

async function executeWithRetry({request, provider, runId, classify, contract, clock}) {
  const runStartedMs = clock.now();
  const requestSnapshot = canonicalJson(request);
  const requestHash = sha256(requestSnapshot);
  const attempts = [];
  let classification;
  let terminalReason = null;
  for (let attemptIndex = 1; attemptIndex <= contract.max_retries + 1; attemptIndex += 1) {
    const attemptStartedMs = clock.now();
    const attemptRecord = Object.freeze({attempt_index: attemptIndex, dispatched: true,
      started_offset_ms: attemptStartedMs - runStartedMs, request_sha256: requestHash});
    const attempt = await provider.send(request, {run_id: runId, attempt_index: attemptIndex,
      attempt_record: attemptRecord});
    if (clock.is_virtual) clock.advance(attempt.latency_ms ?? 0);
    const recordedAttempt = {...attemptRecord, completed_offset_ms: clock.now() - runStartedMs, ...attempt};
    attempts.push(recordedAttempt);
    classification = classify(attempt);
    if (classification.terminal || !classification.retryable || attemptIndex === contract.max_retries + 1) break;
    const decision = retryDecision(attempt, clock.now() - runStartedMs, contract, clock.now());
    recordedAttempt.retry_decision = decision;
    if (!decision.retry) {
      terminalReason = decision.reason;
      break;
    }
    await clock.sleep(decision.wait_ms);
  }
  if (!classification.terminal && classification.retryable) {
    classification = {...classification, terminal: true, status: 'PROVIDER_FAILED',
      failure_reason: terminalReason ?? 'RETRY_EXHAUSTED'};
  }
  return {attempts, classification, request_hash: requestHash,
    retry_wait_ms: clock.sleeps.reduce((sum, wait) => sum + wait, 0),
    wall_time_ms: clock.now() - runStartedMs};
}

async function executePreparedRun(item, provider, fixture, manifest, options = {}) {
  const clock = options.clock ?? new FakeClock();
  const execution = await executeWithRetry({
    request: item.request,
    provider,
    runId: item.run.run_id,
    classify: (attempt) => classifyAttempt(attempt, item.run.task_id, item.schema),
    contract: manifest.execution_contract.transport,
    clock
  });
  const attempts = execution.attempts;
  let classification = execution.classification;

  let evaluated = null;
  if (classification.status === 'STRUCTURED_OUTPUT_VALID') {
    evaluated = evaluateOutput(
      {exposure_weights: fixture.exposure_weights},
      projectOracleCase(item.task),
      classification.parsed_output,
      item.transformed
    );
    classification.status = evaluated.task_success ? 'COMPLETED_CORRECT' : 'COMPLETED_INCORRECT';
  }
  if (!STATUSES.includes(classification.status)) throw new Error(`unclassified status ${classification.status}`);
  const toolLedger = evaluated?.tool_ledger ?? [];
  const ledger = [...item.transformed.agent_ledger, ...toolLedger];
  const lastAttempt = attempts.at(-1);
  const artifact = {
    experiment_id: manifest.experiment_id,
    experiment_contract_version: manifest.experiment_contract_version,
    benchmark_version: manifest.benchmark.version,
    benchmark_tag: manifest.benchmark.tag,
    benchmark_commit: manifest.benchmark.commit,
    ...item.run,
    status: classification.status,
    provider: manifest.provider.name,
    requested_model: manifest.provider.requested_model,
    documented_serving_model: manifest.provider.documented_serving_model,
    returned_model: lastAttempt.response?.model ?? null,
    request_config: manifest.request_contract,
    renderer_sha256: manifest.renderer.sha256,
    schema_sha256: manifest.schemas.per_task_sha256[item.run.task_id],
    fixture_sha256: manifest.benchmark.fixture_sha256,
    manifest_sha256: manifest.manifest_sha256,
    request_sha256: execution.request_hash,
    request: item.request,
    response_id: lastAttempt.response?.id ?? null,
    provider_status: lastAttempt.response?.status ?? null,
    http_status: lastAttempt.http_status ?? null,
    attempt_count: attempts.length,
    retry_count: attempts.length - 1,
    retry_reason: attempts.length > 1 ? (attempts[0].error?.code ?? `HTTP_${attempts[0].http_status}`) : null,
    failure_reason: classification.failure_reason ?? null,
    provider_latency_ms: attempts.reduce((sum, attempt) => sum + (attempt.latency_ms ?? 0), 0),
    retry_wait_ms: execution.retry_wait_ms,
    wall_time_ms: execution.wall_time_ms,
    usage: lastAttempt.response?.usage ?? null,
    attempts,
    raw_output: classification.raw_output ?? null,
    parsed_output: classification.parsed_output ?? null,
    schema_status: classification.schema_status ?? 'not_evaluated',
    schema_error: classification.schema_error ?? null,
    oracle_result: evaluated,
    exposure: {
      agent: summarizeBoundary(ledger, 'AGENT'),
      tool: summarizeBoundary(ledger, 'TOOL'),
      ledger_reference: `${item.run.task_id}/${item.run.strategy}`,
      ledger
    }
  };
  return withSelfHash(artifact, 'artifact_sha256');
}

function successStatistics(results) {
  const perTask = [];
  for (const strategy of STRATEGIES) {
    for (const taskId of TASK_IDS) {
      const cell = results.filter((result) => result.strategy === strategy && result.task_id === taskId);
      const successes = cell.filter((result) => result.status === 'COMPLETED_CORRECT').length;
      perTask.push({task_id: taskId, strategy, successes, repetitions: cell.length,
        success_frequency: successes / cell.length});
    }
  }
  const strategyMacro = Object.fromEntries(STRATEGIES.map((strategy) => {
    const cells = perTask.filter((cell) => cell.strategy === strategy);
    return [strategy, cells.reduce((sum, cell) => sum + cell.success_frequency, 0) / cells.length];
  }));
  const unstable = perTask.filter((cell) => cell.successes > 0 && cell.successes < cell.repetitions);
  return {per_task_success_frequency: perTask, strategy_macro_mean_success_frequency: strategyMacro,
    unstable_cells: unstable, instability_count: unstable.length};
}

function scanSecrets(value) {
  const serialized = canonicalJson(value).toLowerCase();
  const forbidden = ['api_key', 'authorization', 'bearer ', 'cookie', 'deepseek_api_key'];
  return forbidden.filter((needle) => serialized.includes(needle));
}

function summarizeRuns(results, manifest) {
  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const result of results) statusCounts[result.status] += 1;
  const summary = {
    experiment_id: manifest.experiment_id,
    execution_mode: manifest.execution_mode,
    formal_experiment_started: false,
    total_runs: results.length,
    accounted_runs: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
    execution_type: 'offline_mock',
    model_invoked: false,
    research_result: false,
    status_counts: statusCounts,
    retry_attempts: results.reduce((sum, result) => sum + result.retry_count, 0),
    http_attempt_count: results.reduce((sum, result) => sum + result.attempt_count, 0),
    provider_failure_runs: results.filter((result) => ['PROVIDER_FAILED', 'REQUEST_INVALID', 'AUTH_FAILED', 'BALANCE_FAILED'].includes(result.status)).length,
    utility_denominator: results.length,
    completed_correct: statusCounts.COMPLETED_CORRECT,
    repetitions_per_cell: manifest.execution_contract.repetitions,
    independent_task_count: TASK_IDS.length,
    executions_per_strategy: TASK_IDS.length * manifest.execution_contract.repetitions,
    ...successStatistics(results),
    statistical_note: 'The 35 executions per strategy are repeated observations over 7 tasks, not 35 independent tasks; no ordinary Bernoulli confidence interval is reported.',
    secret_scan_matches: scanSecrets({manifest, results}),
    manifest_sha256: manifest.manifest_sha256,
    research_claim: 'none; mock execution validates harness state transitions and artifacts only'
  };
  return withSelfHash(summary, 'summary_sha256');
}

async function runMockExperiment(options = {}) {
  const fixture = loadFixture();
  const manifest = buildManifest(options);
  const prepared = buildPreparedRuns(fixture, manifest);
  const provider = new FakeProvider(buildMockScripts(prepared));
  const results = [];
  for (const item of prepared) {
    results.push(await executePreparedRun(item, provider, fixture, manifest, {clock: new FakeClock()}));
  }
  return {manifest, results, summary: summarizeRuns(results, manifest), provider};
}

function writeArtifacts(report, outputRoot) {
  fs.mkdirSync(path.join(outputRoot, 'runs'), {recursive: true});
  fs.writeFileSync(path.join(outputRoot, 'experiment-manifest.json'), `${JSON.stringify(report.manifest, null, 2)}\n`);
  for (const result of report.results) {
    fs.writeFileSync(path.join(outputRoot, 'runs', `${result.run_id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(report.summary, null, 2)}\n`);
}

module.exports = {
  DEFAULT_EXPERIMENT_ID,
  DEEPSEEK_RESPONSES_URL,
  DeepSeekResponsesAdapter,
  FakeClock,
  FakeProvider,
  INSTRUCTIONS,
  LATIN_ROWS,
  MAX_OUTPUT_TOKENS,
  RANDOMIZATION_SEED,
  RealClock,
  RENDERER_CONTRACT,
  RETRYABLE_HTTP,
  RUN_ORDER_ALGORITHM_VERSION,
  SCHEMA_PATH,
  STATUSES,
  STRATEGY_SYMBOLS,
  TRANSPORT_CONTRACT,
  buildManifest,
  buildMockScripts,
  buildPreparedRuns,
  buildRequest,
  canonicalJson,
  classifyAttempt,
  deterministicOrder,
  dispatchHttpsJson,
  executePreparedRun,
  executeWithRetry,
  loadSchemas,
  parseRetryAfter,
  projectLlmCase,
  renderLlmCase,
  retryDecision,
  runMockExperiment,
  scanSecrets,
  sha256,
  successStatistics,
  summarizeRuns,
  validateAgainstSchema,
  withSelfHash,
  writeArtifacts
};
