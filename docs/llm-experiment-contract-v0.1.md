# MinDisclosure LLM Experimental Contract v0.1

Status: **FROZEN — OFFLINE VALIDATED — NO LIVE MODEL RESULTS**

Benchmark binding: `md-bench-v0.2`

## 1. Frozen boundary

The experiment may replace only the deterministic solver with one LLM request. It must not modify the seven tasks, four strategies, transformer, finite transformation space, No-Solver Rule, exposure weights, restoration, or deterministic oracle. Oracle MinDisclosure remains a reference that is minimum feasible only within the frozen finite transformation space.

```text
frozen fixture -> frozen transformer -> Agent-visible input -> LLM solver
  -> schema validation -> frozen restoration/oracle -> result
```

Only the public task instruction and transformed Agent-visible input enter the request. Ground truth, requirements, strategy name, ledgers, Oracle-search evidence, and hidden raw values are excluded. Agent and Tool exposure remain separate; failure never erases disclosure that already occurred.

## 2. Provider and request contract

| Field | Frozen value |
|---|---|
| Provider/API | DeepSeek `POST /responses` |
| Requested model | `deepseek-flash` |
| Documented serving model at calibration | `DeepSeek-V4.1-Flash` |
| Thinking | `reasoning.effort=none` |
| Temperature | `0` |
| `top_p` | omitted |
| Structured output | `text.format.type=json_schema` |
| `max_output_tokens` | `256` |
| Stream/tools/user/state | `stream=false`; all others omitted |
| Repetitions | 5 |
| Topology | serial, concurrency 1 |

`deepseek-flash` is a movable alias. The manifest records the requested identifier, documented serving model, calibration timestamp, and provider notes. `temperature=0` is not a deterministic-decoding guarantee, and `reasoning.effort=none` results represent only the non-thinking condition. These generation values and the timeout/retry values below come from separate calibration, not provider defaults. The five repetitions characterize residual run-to-run instability; they do not create additional independent tasks.

The seven closed schemas are in `fixtures/llm-output-schemas-v0.1.json`. They contain no answers or examples and use `additionalProperties=false`. An empty, malformed, schema-invalid, incomplete, content-filtered, or wrong answer receives its terminal classification with no model repair, reprompt, larger token budget, or extra repetition.

## 3. Strategy-blind rendering

All four strategies for a task share the same public instruction, schema, model configuration, and renderer. Only the transformed Agent-visible input differs. The exact instructions are:

```text
Complete the provided task using only the provided input data. Return only the structured result. Do not explain your reasoning.
```

The input is the frozen public task text plus canonical JSON of the transformed data. No strategy, privacy, representation, or exposure label is included. `MD-TOOL-07` returns ordinary schema-constrained JSON; provider function calling is disabled and frozen local restoration performs Tool-boundary evaluation.

## 4. Formal run order

The manifest freezes algorithm `balanced-williams-blocks-v0.1`, seed `md-bench-v0.2-llm-contract-v0.1-seed-20260916`, canonical task order, strategy symbols, Latin rows, and all 140 final run identities.

Symbols are A=`FIXED_REDACTION`, B=`STABLE_TOKENIZATION`, C=`ORACLE_MIN_DISCLOSURE`, D=`RAW_DISCLOSURE`. The Williams rows are:

```text
[A, B, D, C]
[B, C, A, D]
[C, D, B, A]
[D, A, C, B]
```

For repetition `r`, tasks are sorted by `SHA256(seed + "/rep/" + r + "/" + task_id)`. For each task, row `(canonical_task_index + r) mod 4` is used. Each task×repetition block contains its four strategies contiguously. Rebuilding the manifest must reproduce identical canonical bytes and self hash.

## 5. Timeout and retry state machine

| Parameter | Frozen value |
|---|---:|
| SDK automatic retries | 0 |
| connect timeout | 5,000 ms, inside the attempt budget |
| per-attempt total timeout | 180,000 ms |
| whole logical-run wall timeout | 480,000 ms |
| harness retries | at most 1 identical retry |
| 429 without valid header | 3,000 ms |
| 500/503 | 1,000 ms |
| connection failure | 1,000 ms |
| attempt timeout | 1,000 ms |
| accepted `Retry-After` maximum | 120,000 ms |
| jitter | none |

The harness owns retries so every actual HTTP dispatch is visible. `attempt_count` equals `attempts.length`; local pre-request validation is not an attempt. A transport retry keeps the same logical run and does not add a repetition.

An exact valid `Retry-After` is obeyed only when it is at most 120 seconds and a full second attempt plus the wait fits strictly inside the 480-second wall budget. A larger header ends with `RETRY_AFTER_EXCEEDS_CAP`; inadequate budget ends with `INSUFFICIENT_RUN_WALL_BUDGET_FOR_RETRY`. Missing 429 headers use three seconds. HTTP 500/503, connection failure before a classifiable response, and attempt timeout use one second. HTTP 400/422, 401, 402, provider incomplete/failed response objects, and all model-output failures are not retried.

## 6. Status and privacy accounting

Terminal statuses are `COMPLETED_CORRECT`, `COMPLETED_INCORRECT`, `INVALID_OUTPUT`, `INCOMPLETE_OUTPUT`, `PROVIDER_FAILED`, `REQUEST_INVALID`, `AUTH_FAILED`, and `BALANCE_FAILED`. Every selected logical run remains in the denominator.

Agent exposure is recorded when transformed input is sent, including failed runs. A schema-valid `MD-TOOL-07` output is locally restored and checked even when wrong; any real field actually dispatched at the Tool boundary remains fully counted. A provider failure before a valid local tool call has no Tool exposure, but its Agent exposure remains.

## 7. Results and artifacts

Each task×strategy cell reports `successes/5` and retains all five raw observations. Each strategy reports the macro mean of its seven task-level frequencies. A cell with `0 < successes < 5` is unstable; the summary reports the list and count. The 35 executions per strategy are repeated observations over seven tasks, not 35 independent tasks, so no ordinary Bernoulli confidence interval is reported.

The canonical offline validation artifact is:

```text
artifacts/llm/md-bench-v0.2-deepseek-flash-contract-v0.1-offline-validation/
  experiment-manifest.json
  runs/run-001.json ... runs/run-140.json
  summary.json
```

The mock uses a fake clock and covers correct, incorrect, malformed, incomplete/token-limit, content filter, 429 with and without `Retry-After`, over-cap header, 500/503, connection failure, attempt timeout, insufficient wall budget, 400/401/402/422, provider failure, and wrong Tool-call exposure. It makes no network call and its scripted outcomes are not LLM observations or evidence of model performance.
Its manifest and summary explicitly record `execution_type=offline_mock`, `model_invoked=false`, and `research_result=false`. The manifest self hash is computed over canonical serialization with `manifest_sha256` omitted, avoiding recursive hash semantics. It also records the contract document, schema document, renderer, frozen fixture, and run-order identities and hashes.


## 8. Formal start gate

Before any real call, recheck official provider model, Responses, pricing, errors, rate-limit, and change-log documentation; assign a distinct formal experiment ID; record the fresh provider timestamp and serving-model statement; verify credentials outside artifacts; confirm the chosen transport exposes every dispatch with SDK retries disabled; and run request-construction preflight. Formal execution must not alter this contract in response to outcomes.
