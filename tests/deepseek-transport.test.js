'use strict';

const {EventEmitter} = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DeepSeekResponsesAdapter,
  FakeClock,
  TRANSPORT_CONTRACT,
  canonicalJson,
  classifyAttempt,
  dispatchHttpsJson,
  executeWithRetry,
  scanSecrets,
  sha256
} = require('../src/llm-experiment');
const {CANARY_SCHEMA, buildCanaryRequest, requestPreflight} = require('../src/run-deepseek-smoke');

function responsePayload(output = '{"ok":true}') {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'deepseek-flash',
    output: [{type: 'message', content: [{type: 'output_text', text: output}]}],
    usage: {input_tokens: 3, output_tokens: 3, total_tokens: 6}
  };
}

function requestStub(spec, capture) {
  return (url, options, callback) => {
    capture.dispatches += 1;
    capture.url = String(url);
    capture.options = options;
    const request = new EventEmitter();
    request.end = (payload) => {
      capture.body = payload.toString('utf8');
      if (spec.neverRespond) return;
      process.nextTick(() => {
        request.emit('socket', {connecting: false});
        const response = new EventEmitter();
        response.statusCode = spec.status ?? 200;
        response.headers = spec.headers ?? {'content-type': 'application/json', 'x-request-id': 'req_test'};
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify(spec.body ?? responsePayload())));
        response.emit('end');
      });
    };
    request.destroy = (error) => process.nextTick(() => request.emit('error', error));
    return request;
  };
}

function frozenAttemptRecord() {
  return Object.freeze({attempt_index: 1, dispatched: true, started_offset_ms: 0,
    request_sha256: sha256(buildCanaryRequest())});
}

test('offline preflight freezes the exact benchmark-shaped request', () => {
  const preflight = requestPreflight();
  assert.equal(preflight.passed, true);
  assert.deepEqual(scanSecrets(preflight.request), []);
  assert.equal(preflight.request_sha256, sha256(preflight.request));
  assert.deepEqual(preflight.selected_case,
    {task_id: 'MD-EQ-01', strategy: 'STABLE_TOKENIZATION', repetition_index: 1});
});

test('authorization exists only at dispatch and never enters body, hash, or returned attempt', async () => {
  const prior = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-secret-never-log';
  const capture = {dispatches: 0};
  try {
    const adapter = new DeepSeekResponsesAdapter({requestImpl: requestStub({}, capture)});
    const request = buildCanaryRequest();
    const result = await adapter.send(request, {attempt_record: frozenAttemptRecord()});
    assert.equal(capture.options.headers.authorization, ['Bearer', 'test-secret-never-log'].join(' '));
    assert.equal(capture.body, canonicalJson(request));
    assert.equal(capture.body.includes('test-secret-never-log'), false);
    assert.equal(canonicalJson(result).includes('test-secret-never-log'), false);
    assert.equal(result.response.model, 'deepseek-flash');
    assert.equal(result.response_headers['x-request-id'], 'req_test');
    assert.equal(sha256(request), sha256(JSON.parse(capture.body)));
    assert.equal(adapter.dispatch_count, 1);
  } finally {
    if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prior;
  }
});

test('one harness attempt equals one HTTP dispatch and there are no hidden retries', async () => {
  const prior = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  const capture = {dispatches: 0};
  try {
    const adapter = new DeepSeekResponsesAdapter({requestImpl: requestStub({}, capture)});
    const execution = await executeWithRetry({
      request: buildCanaryRequest(),
      provider: adapter,
      runId: 'transport-test',
      classify: (attempt) => classifyAttempt(attempt, 'SMOKE-A', CANARY_SCHEMA),
      contract: TRANSPORT_CONTRACT,
      clock: new FakeClock()
    });
    assert.equal(execution.attempts.length, 1);
    assert.equal(capture.dispatches, 1);
    assert.equal(adapter.dispatch_count, 1);
  } finally {
    if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prior;
  }
});

test('Retry-After and auditable response metadata survive transport parsing', async () => {
  const capture = {dispatches: 0};
  const result = await dispatchHttpsJson({
    url: 'https://api.deepseek.com/responses',
    body: canonicalJson(buildCanaryRequest()),
    authorization: 'Bearer test-only',
    connectTimeoutMs: 100,
    attemptTimeoutMs: 100,
    requestImpl: requestStub({status: 429, headers: {'retry-after': '2', 'x-request-id': 'req_429'},
      body: {error: {code: 'rate_limit', message: 'retry later'}}}, capture)
  });
  assert.equal(result.http_status, 429);
  assert.equal(result.retry_after, '2');
  assert.deepEqual(result.response_headers, {'retry-after': '2', 'x-request-id': 'req_429'});
  assert.equal(result.provider_error.code, 'rate_limit');
  assert.equal(result.response, null);
  assert.equal(capture.dispatches, 1);
});

test('attempt timeout is classified without a second hidden dispatch', async () => {
  const capture = {dispatches: 0};
  const result = await dispatchHttpsJson({
    url: 'https://api.deepseek.com/responses',
    body: canonicalJson(buildCanaryRequest()),
    authorization: 'Bearer test-only',
    connectTimeoutMs: 100,
    attemptTimeoutMs: 5,
    requestImpl: requestStub({neverRespond: true}, capture)
  });
  assert.equal(result.transport_failure, 'attempt_timeout');
  assert.equal(result.error.code, 'ATTEMPT_TIMEOUT');
  assert.equal(capture.dispatches, 1);
});

test('adapter fails closed before dispatch when credential is absent', async () => {
  const prior = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const capture = {dispatches: 0};
  try {
    const adapter = new DeepSeekResponsesAdapter({requestImpl: requestStub({}, capture)});
    await assert.rejects(() => adapter.send(buildCanaryRequest(),
      {attempt_record: frozenAttemptRecord()}), /MISSING_DEEPSEEK_API_KEY/);
    assert.equal(capture.dispatches, 0);
    assert.equal(adapter.dispatch_count, 0);
  } finally {
    if (prior !== undefined) process.env.DEEPSEEK_API_KEY = prior;
  }
});
