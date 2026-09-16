# Minimum Disclosure Benchmark Specification

Status: **FROZEN DETERMINISTIC BENCHMARK METHODOLOGY**

Version: `md-bench-v0.2`

Historical version: `md-bench-v0.1` remains frozen at its existing tag and release.

## 1. Research boundary

The benchmark asks whether a search-derived oracle disclosure can preserve Raw Disclosure utility while reducing raw-value exposure, especially where Stable Tokenization lacks a required field property. It does not claim novelty for task-aware privacy and does not measure a deployable planner.

The two privacy boundaries are reported separately:

- **Agent boundary:** everything actually sent to the downstream task solver.
- **Tool boundary:** values actually sent in an invoked tool call after any trusted restoration.

Task failure never clears either ledger.

## 2. No-Solver Rule

> Disclosure layer may transform information, but must not solve the downstream task.

```text
Raw Input
  -> Candidate Disclosure Plan
  -> Disclosure Transformation
  -> Transformed Agent-visible Input
  -> Downstream Task Solver
  -> Task Output
  -> Success Oracle
```

The transformer receives only `task_id`, raw input, sensitive-entity annotations, gold requirements, a candidate disclosure plan, and source relations. It does not receive the user instruction, expected output schema, ground truth, or success oracle. It has no dependency on the solver or oracle modules.

The deterministic reference solver receives only `task_id`, the common instruction, and transformed input. It does not receive raw hidden fields, gold requirements, ground truth, strategy label, restoration map, or oracle configuration. The success oracle runs only after solver output exists.

Allowed operations are occurrence-local redaction, stable/reversible tokenization, field-local coarsening, field-local unary property extraction, raw retention, and tokenized preservation of a relation already explicit in the source. Rank, duplicate group, matching pair, time-window result, argmax/argmin, aggregate, selected ticket, final recipient, degree, reachability, and other answer-equivalent transformations are prohibited.

## 3. Search-derived Oracle MinDisclosure

The human-authored `oracle_disclosure_plan` in the task fixture is retained only as a comparison plan. The executed `ORACLE_MIN_DISCLOSURE` plan is produced by search.

### 3.1 Frozen ordered chains

Only transformations needed by the seven current tasks are included:

| Field family / task | Ordered chain, least to most revealing |
|---|---|
| Email identity (`EQ`) | `REDACT < STABLE_TOKEN < RAW_VALUE` |
| Contact email (`GROUP`) | `REDACT < STABLE_TOKEN < DOMAIN_HANDLE < RAW_VALUE` |
| Date of birth | `REDACT < STABLE_TOKEN < BIRTH_YEAR < RAW_VALUE` |
| Address (`LOC`, `TOOL`) | `REDACT < STABLE_TOKEN < SERVICE_ZONE < RAW_VALUE` |
| Subject email (`CROSS`) | `REDACT < STABLE_TOKEN < RAW_VALUE` |
| Timestamp | `REDACT < STABLE_TOKEN < HOUR_BUCKET < RAW_VALUE` |
| Person name (`GRAPH`) | `REDACT < STABLE_TOKEN < RAW_VALUE` |
| Recipient email (`TOOL`) | `REDACT < reversible STABLE_TOKEN < RAW_VALUE` |

`CITY` is not present because no frozen task requires it. Choices apply uniformly to every occurrence in one field dimension; search may not selectively expose only records that participate in the answer.

### 3.2 Search procedure

For every product-space candidate:

```text
candidate plan
  -> existing No-Solver transformer
  -> deterministic reference solver
  -> existing success oracle
```

A candidate is feasible exactly when task utility is `PASS`. Privacy minimality uses the component-wise partial order induced by the frozen chains. Plan A dominates B when every dimension of A is no more revealing and at least one dimension is strictly less revealing. Weighted exposure is not used to choose the plan.

All undominated feasible plans are recorded. When more than one exists, the selected reporting plan is the lexicographically smallest level vector in frozen dimension order, then canonical action JSON. This tie-break is deterministic and does not imply a unique global minimum.

The search may query the deterministic success oracle but cannot change the transformer, solver, task, or transformation space. Minimality is claimed only within this finite space.

## 4. Baselines

### `FIXED_REDACTION`

Every sensitive occurrence receives a fresh occurrence-local placeholder. It does not intentionally preserve underlying entity identity and has no restoration map.

### `STABLE_TOKENIZATION`

- Sensitive surface values become neutral task-local opaque tokens.
- Occurrences with the same entity identity receive the same token.
- Non-deleted structure and source relations already present in input may remain present.
- It derives no new property or relation and performs no cross-record semantic computation.
- A task-local restoration map is used only for declared tool arguments.

Thus Stable can solve identity/equality work and graph work whose edge structure already exists in source input. “Only preserves identity/equality” is not used as a blanket description.

### `ORACLE_MIN_DISCLOSURE`

The strategy executes the selected search-derived minimum feasible plan. It is an oracle benchmark reference, not an automatic requirement predictor or deployable policy.

### `RAW_DISCLOSURE`

All sensitive occurrences remain raw at the Agent boundary. It is a utility ceiling and maximum raw-value reference, not a recommended policy.

All strategies share task instruction, record order, output schema, parser, solver, oracle, and tool/restoration topology. Only the sensitive representation differs.

## 5. Disclosure ledger and metrics

| Representation | Meaning | Reporting weight |
|---|---|---:|
| `RAW_VALUE` | Exact source value | 1.00 |
| `COARSENED_VALUE` | Declared lower-resolution field value | 0.50 |
| `DERIVED_PROPERTY` | Declared field-local unary property | 0.50 |
| `RELATION_ONLY` | Declared relation already present in source | 0.25 |
| `OPAQUE_TOKEN` | Task-local stable identity handle | 0.10 |
| `REDACTED` | Occurrence-local removal marker | 0.00 |

Weights remain a reporting convention, not a universal privacy metric and not the Oracle search objective. Reports retain task success, category counts, raw occurrence/distinct counts, separate Agent and Tool exposure, normalized Agent exposure, and the complete ledger.

Every ledger item records task, strategy, boundary, source occurrence IDs, representation, disclosed name/value, requirement ID where applicable, and weight. Exposure reflects data actually sent even when the output is wrong.

## 6. Tool invocation and restoration contract

Every result records:

- `tool_invoked`: whether a schema-valid call reached the trusted tool boundary;
- `tool_call_valid`: whether the call matched the frozen structural tool schema;
- `tool_call_correct`: whether the restored call exactly matched ground truth.

These are independent of task success and privacy accounting. If a wrong but structurally valid call is invoked with a real value, that value remains in the Tool ledger.

For `MD-TOOL-07`, Stable selects the correct ticket and its recipient token can be restored, but it cannot derive the service zone. The call is therefore `tool_invoked=true`, `tool_call_valid=true`, `tool_call_correct=false`, with Tool `RAW_VALUE=1` and Tool exposure `1.0`.

Restore reporting retains restored items, correctly restored items, exact-match rate, unknown tokens, and accidental raw output.

## 7. Deterministic task set and selected minima

| Task | Solver work retained | Search-derived minimum | Stable expectation |
|---|---|---|---|
| `MD-EQ-01` | Deduplicate | `STABLE_TOKEN` | PASS |
| `MD-GROUP-02` | Group and sum | `DOMAIN_HANDLE` | FAIL |
| `MD-ORDER-03` | Sort | `BIRTH_YEAR` | FAIL |
| `MD-LOC-04` | Zone group/count/sum | `SERVICE_ZONE` | FAIL |
| `MD-CROSS-05` | Identity match and 72h comparison | `STABLE_TOKEN × HOUR_BUCKET` | FAIL |
| `MD-GRAPH-06` | Degree and two-hop reachability | `STABLE_TOKEN` plus existing source edges | PASS |
| `MD-TOOL-07` | Select and construct call | reversible `STABLE_TOKEN × SERVICE_ZONE` | FAIL |

Each selected plan is the only Pareto-minimal feasible plan in the current search space and matches the original human plan.

## 8. Deterministic oracle and falsification

Output schemas are closed. Wrong order, group, aggregate, time match, graph result, tool argument, or restoration fails. No LLM judge or fuzzy scoring is used.

The strong controls are `MD-EQ-01` and `MD-GRAPH-06`; Stable and Oracle should both pass without an Oracle-only hint. The hypothesis is weakened if search needs raw Agent values on multiple tasks, cannot match Raw utility, yields answer-equivalent representations, or if Stable succeeds on most property-dependent tasks.

Discovery of a lower feasible plan inside the frozen chains, selective-record disclosure, or a transformer path to solver/oracle data invalidates the frozen version and requires a new versioned repair.

## 9. Freeze status

The included run remains deterministic methodology validation over `7 tasks × 4 strategies`, using Node.js built-ins with no network, external dependency, or LLM. The deterministic methodology assets are frozen as `md-bench-v0.2`. Designing or executing a formal LLM Experimental Contract is explicitly outside this correction.
