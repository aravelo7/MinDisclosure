# Minimum Disclosure Benchmark Specification

Status: **FROZEN SPECIFICATION**  
Version: `md-bench-v0.1`  
Frozen task IDs: `MD-EQ-01`, `MD-GROUP-02`, `MD-ORDER-03`, `MD-LOC-04`, `MD-CROSS-05`, `MD-GRAPH-06`, `MD-TOOL-07`

This freeze covers the task data, annotations, representations, deterministic oracles, exposure convention, baseline semantics, and falsification rules. It does not freeze a runtime, model/provider, prompt renderer, run count, retry policy, or generation parameters.

## 1. Benchmark question and boundary

The benchmark asks one narrow question:

> What task utility can Task-aware Disclosure preserve using explicitly required sensitive properties or relations that Stable Tokenization cannot preserve using entity identity/equality alone?

The primary privacy boundary is the **Agent boundary**: information visible to the model that performs the task. A trusted local transformer, token map, oracle, and restoration step are outside that boundary. Any raw value sent after restoration to a downstream tool is recorded in a separate **Tool boundary** ledger and must never be silently combined with Agent exposure.

Version 0.1 assumes gold sensitive-entity and requirement annotations. It evaluates disclosure policy, not entity detection, requirement induction, proxy behavior, or prompt-injection resistance. Requirement induction may be studied later as a separate experimental dimension.

## 2. Frozen Task Benchmark

The seven fixtures and exact answers are in `task-cases.md`.

| Task | Capability isolated | Expected discriminating result |
|---|---|---|
| `MD-EQ-01` | Equality / deduplication | Fixed should fail; Stable and Task-aware can pass. |
| `MD-GROUP-02` | Grouping and aggregation by a derived domain relation | Stable identity tokens are insufficient; Task-aware may pass using same-domain relations. |
| `MD-ORDER-03` | Ordering without exact dates | Stable tokens are insufficient; Task-aware may pass using ranks/order relations. |
| `MD-LOC-04` | Coarse location | Stable tokens are insufficient; Task-aware may pass using service-zone values. |
| `MD-CROSS-05` | Cross-record identity plus time-window relation | Stable preserves identity but not the time-window relation; Task-aware must preserve both. |
| `MD-GRAPH-06` | Relation graph | Stable is a required strong control and should pass; Task-aware may reduce exposure using relation-only input. |
| `MD-TOOL-07` | Property-dependent selection plus exact restored tool argument | Stable can restore the recipient but cannot derive the zone; Task-aware must disclose the zone and use reversible recipient tokenization. |

The set is intentionally not all pro-Task-aware. `MD-EQ-01` and `MD-GRAPH-06` test whether Stable Tokenization already solves identity-only work. `MD-TOOL-07` tests that exact output does not automatically require raw Agent exposure when trusted restoration is available.

## 3. Frozen task schema

The following is a documentation schema, not a runtime class:

```json
{
  "benchmark_version": "md-bench-v0.1",
  "task_id": "MD-...",
  "raw_input": {},
  "user_instruction": "string",
  "expected_output_schema": {},
  "ground_truth": {},
  "success_oracle": {
    "kind": "exact_json | set_equality | ordered_list | exact_tool_call",
    "normalization": "rules stated per task"
  },
  "sensitive_entities": [],
  "task_requirements": [],
  "explicitly_not_required": [],
  "strategy_rationale": {}
}
```

Freeze invariants:

1. `raw_input`, `user_instruction`, output schema, ground truth, and oracle are identical across strategies.
2. Strategy-specific transformed inputs are generated from the same gold annotations; they are not separate hand-authored prompts.
3. Record IDs and other benchmark control identifiers are non-sensitive unless a task explicitly says otherwise.
4. The Agent never receives `ground_truth`, oracle details, requirement annotations, representation ledgers, or strategy labels.
5. Output prose is disallowed. The oracle parses one JSON value matching the frozen schema.

## 4. Annotation Specification

### 4.1 Sensitive Entity

```json
{
  "occurrence_id": "occ_email_r1",
  "source_path": "$.records[0].email",
  "entity_type": "EMAIL",
  "entity_identity": "email_alice_northwind",
  "raw_value": "alice@northwind.example",
  "sensitive_properties": {
    "domain": "northwind.example",
    "domain_class": "corporate"
  }
}
```

- `occurrence_id` identifies one appearance at one source path.
- `entity_type` is the gold semantic type. Baselines do not automatically expose it.
- `entity_identity` is present only when occurrences must be known to refer to the same underlying entity. It is construction-side metadata.
- `sensitive_properties` contains only benchmark-declared properties that may be required or explicitly withheld. It is not sent wholesale to the Agent.
- `raw_value` is evaluator-side data and is never Agent-visible unless the chosen representation is `RAW_VALUE` at the Agent boundary.

### 4.2 Task Requirement

```json
{
  "requirement_id": "req_same_domain",
  "kind": "required_property | required_relation",
  "name": "same_email_domain",
  "target": ["occ_email_r1", "occ_email_r2"],
  "exact_value_required": false,
  "required_at_boundary": "AGENT | POST_RESTORE_OUTPUT | TOOL",
  "allowed_representations": ["RELATION_ONLY", "DERIVED_PROPERTY"]
}
```

- A required property is a unary fact about a target, such as `service_zone=EAST`.
- A required relation is an n-ary fact, such as `before(a,b)`, `same_domain(a,b)`, or `referred(a,b)`.
- `target` names the entity occurrences, identities, records, output field, or tool argument governed by the requirement.
- `exact_value_required` means the target boundary must receive the exact raw value. It does **not** mean the Agent must see that raw value. `MD-TOOL-07` requires exact email after trusted restoration, not in the model prompt.
- Anything absent from `task_requirements` is denied to Task-aware Disclosure by default.

### 4.3 Disclosure Representation

Every Agent-visible sensitive occurrence or explicitly emitted sensitive fact receives exactly one primary representation record. Separately emitted relations receive their own record.

| Representation | What the Agent learns | What the Agent does not receive |
|---|---|---|
| `RAW_VALUE` | Exact surface value, its occurrence position, and any properties the Agent can infer from it. | Nothing intentionally withheld about that surface value. |
| `COARSENED_VALUE` | A declared lower-resolution value, for example `service_zone=EAST`. | Exact address and undeclared address components. |
| `DERIVED_PROPERTY` | A declared computed property, for example `age_rank=2`. | The raw value and other properties not implied by that property. |
| `RELATION_ONLY` | Only a named relation among opaque record/entity references, for example `before(r2,r1)`. | Raw endpoint values and unrelated endpoint properties. |
| `OPAQUE_TOKEN` | A stable, neutral handle and therefore occurrence linkage/equality within the frozen scope. | Raw value, entity type, format, length, and semantic properties. |
| `REDACTED` | Only that content was removed at a particular structural position. | Value, type, identity, equality, properties, and relations. |

For the same original entity, representations are not aliases for one another. `OPAQUE_TOKEN` exposes identity linkage but no age, domain, locality, order, or semantic type. `RELATION_ONLY` exposes the declared edge but need not expose a persistent entity handle outside that edge. `DERIVED_PROPERTY` exposes only its named value. A reversible map outside the Agent boundary does not turn an Agent-visible opaque token into raw Agent exposure.

Required ledger fields:

```json
{
  "boundary": "AGENT",
  "source_occurrence_ids": ["occ_1"],
  "representation": "OPAQUE_TOKEN",
  "disclosed_name": "identity_handle",
  "disclosed_value": "<E_001>",
  "strategy": "STABLE_TOKENIZATION"
}
```

## 5. Metrics

### 5.1 Task Utility

Each task returns binary `task_success` from its deterministic oracle. No LLM judge is used in v0.1.

- Malformed JSON, extra fields, prose outside JSON, missing fields, or schema mismatch is failure.
- Arrays declared as ordered must match exactly.
- Sets are normalized only where a task explicitly declares set semantics.
- Counts, sums, relation edges, and tool names/arguments must match their frozen ground truth.
- Dataset utility is reported as `successful_tasks / eligible_tasks`, plus the seven individual outcomes. The individual outcomes are mandatory because the tiny task set must not be hidden behind one average.

### 5.2 Privacy Exposure

Exposure is computed from the actual boundary-tagged disclosure ledger, not from the number of source fields and not from an LLM's guessed inferences.

Benchmark convention weights:

| Representation | Points per ledger item |
|---|---:|
| `RAW_VALUE` | 1.00 |
| `COARSENED_VALUE` | 0.50 |
| `DERIVED_PROPERTY` | 0.50 |
| `RELATION_ONLY` | 0.25 |
| `OPAQUE_TOKEN` | 0.10 |
| `REDACTED` | 0.00 |

These weights are a transparent **benchmark convention**, not a universal privacy metric and not an information-theoretic claim. They encode only the ordinal design decision:

`RAW_VALUE > COARSENED_VALUE / DERIVED_PROPERTY > RELATION_ONLY > OPAQUE_TOKEN > REDACTED`.

Accounting rules:

1. Count one ledger item for each transformed sensitive occurrence visible at a boundary. Repetition therefore remains visible in the raw counts.
2. Count each separately emitted derived property or relation fact once. An n-ary relation tuple is one relation item.
3. Do not additionally score properties merely inferable from a raw value; the raw item already receives the highest category.
4. If one rendered item qualifies for multiple categories, assign the highest category only. Explicit additional relation/property items remain separate.
5. Compute boundary-specific score `E_b = sum(weight(representation))`. Never merge Agent and Tool boundary scores.
6. Compare strategies primarily within the same task. Across tasks, report the sum and macro mean of per-task scores, but retain every per-task ledger because task fact inventories differ.

Mandatory exposure report columns:

- raw-value occurrence count and distinct raw-value count;
- count of items in every representation category;
- Agent-boundary aggregate exposure score;
- Tool-boundary raw count, category counts, and aggregate score;
- the complete disclosure ledger or a lossless artifact reference.

The aggregate score may not be reported alone.

### 5.3 Relationship Preservation

There is no generic relationship score. Each applicable task reports deterministic named checks:

- `equality_preserved` for `MD-EQ-01`;
- `grouping_preserved` and `aggregate_values_correct` for `MD-GROUP-02`;
- `ordering_preserved` for `MD-ORDER-03`;
- `coarse_location_preserved` for `MD-LOC-04`;
- `identity_preserved` and `window_relation_preserved` for `MD-CROSS-05`;
- `relation_edges_preserved` for `MD-GRAPH-06`;
- `selection_preserved`, `tool_argument_property_preserved`, and `exact_recipient_after_restore` for `MD-TOOL-07`.

Each check is binary and is derived directly from the parsed output or transformed fixture. Non-applicable checks are `not_applicable`, not zero.

### 5.4 Restore Correctness

Restore correctness is computed only for a strategy/instance that produced reversible tokens.

For every model-emitted token at an output field marked restorable:

```text
restore_correct = restored value exactly equals the gold raw value bound to that token
```

Report `restored_items`, `correctly_restored_items`, exact-match rate, unknown-token count, and accidental-raw-output count. For `MD-TOOL-07`, restore correctness is also part of task success because the tool requires the exact recipient. For other tasks it is reported independently. Fixed Redaction is `not_applicable`; Task-aware is applicable only where it chooses reversible tokens.

## 6. Experimental Contract

### 6.1 Baseline A — Fixed Redaction

- Replace every annotated sensitive occurrence with a fresh occurrence-local neutral placeholder such as `<REDACTED_001>`.
- Do not add type labels, stable IDs, format/length hints, properties, or relations. The numeric suffix follows occurrence order only.
- Placeholders are never reused, including when two occurrences have the same raw value. They are not identity handles and cannot encode equality or inequality between underlying entities.
- No restoration map exists.
- Preserve non-sensitive structure and fields exactly.

### 6.2 Baseline B — Stable Tokenization

- Within one task instance, all occurrences with the same gold `entity_identity` receive the same neutral token; different identities receive different tokens.
- If `entity_identity` is absent, equality is based on exact normalized raw value as declared by that task. No cross-task or cross-instance linkage is allowed.
- Tokens use neutral forms such as `<E_001>` and reveal no entity type, format, raw length, ordering, hash prefix, or semantic property.
- Token assignment follows first occurrence in the already fixed input order; it must not depend on lexical/raw-value sorting.
- Only equality/identity is intentionally preserved. No domain, age, locality, order, distance, family relation, or other property is computed or exposed.
- A trusted task-local reversible map may restore a copied token in a declared output field. The Agent never receives that map.

### 6.3 Baseline C — Task-aware Disclosure

- Begin from the same gold sensitive occurrences and same user instruction.
- Disclose only properties and relations explicitly allowlisted by `task_requirements`.
- Use the least expressive allowed representation that is sufficient under the frozen task annotation; everything else is an opaque token or redacted.
- Exact raw values are Agent-visible only when `exact_value_required=true` specifically at the Agent boundary. Exact values required only after restoration remain tokenized for the Agent.
- Do not add explanations, hints, oracle facts, task decompositions, or strategy-specific instructions.
- Every disclosed item must appear in the boundary ledger and trace to a requirement ID.

The logical disclosure plan is frozen per task. A later renderer may choose JSON field syntax, but it may not change these facts or categories after observing results:

| Task | Frozen Agent-visible sensitive disclosure |
|---|---|
| `MD-EQ-01` | Redact all four email occurrences; add only `same_email_identity(r1,r3)=true` as one `RELATION_ONLY` item. |
| `MD-GROUP-02` | Redact all four emails; add `same_email_domain(i1,i2)=true` and `same_email_domain(i1,i4)=true` as two `RELATION_ONLY` items. `same_email_domain` is declared transitive, so no third redundant edge is emitted. |
| `MD-ORDER-03` | Replace each date with its `oldest_rank` as four `DERIVED_PROPERTY` items. |
| `MD-LOC-04` | Replace each address with its `service_zone` as four `COARSENED_VALUE` items. |
| `MD-CROSS-05` | Redact all email and timestamp occurrences; add only `same_subject_within_72_hours(e1,e3)=true` as one `RELATION_ONLY` item. Absence of another pair means false under the closed-world fixture. |
| `MD-GRAPH-06` | Redact all person-name occurrences; add the three directed clinician edges as three `RELATION_ONLY` items. Do not disclose the patient node. |
| `MD-TOOL-07` | For selected ticket `t2`, expose its recipient as one reversible `OPAQUE_TOKEN` and its address as one `COARSENED_VALUE` (`service_zone=EAST`); redact the other four sensitive occurrences. Selection uses the already visible severity field and adds no sensitive fact. |

Expected Agent-boundary ledger counts provide a transformation sanity check, not a utility prediction:

| Task | Fixed Redaction | Stable Tokenization | Task-aware |
|---|---|---|---|
| `MD-EQ-01` | `REDACTED=4` | `OPAQUE_TOKEN=4` | `REDACTED=4, RELATION_ONLY=1` |
| `MD-GROUP-02` | `REDACTED=4` | `OPAQUE_TOKEN=4` | `REDACTED=4, RELATION_ONLY=2` |
| `MD-ORDER-03` | `REDACTED=4` | `OPAQUE_TOKEN=4` | `DERIVED_PROPERTY=4` |
| `MD-LOC-04` | `REDACTED=4` | `OPAQUE_TOKEN=4` | `COARSENED_VALUE=4` |
| `MD-CROSS-05` | `REDACTED=10` | `OPAQUE_TOKEN=10` | `REDACTED=10, RELATION_ONLY=1` |
| `MD-GRAPH-06` | `REDACTED=9` | `OPAQUE_TOKEN=9` | `REDACTED=9, RELATION_ONLY=3` |
| `MD-TOOL-07` | `REDACTED=6` | `OPAQUE_TOKEN=6` | `REDACTED=4, OPAQUE_TOKEN=1, COARSENED_VALUE=1` |

At the Tool boundary for `MD-TOOL-07`, Stable and Task-aware each have one `RAW_VALUE` item after successful restoration. Fixed Redaction has no valid restorable item.

### 6.4 Shared conditions

All three strategies must share:

- identical raw task instance and record order;
- identical user task instruction;
- identical model and provider;
- identical system prompt and prompt wrapper;
- identical generation parameters, seed policy, token budget, stop rules, timeout semantics, and retry policy;
- identical output schema and parser;
- identical success oracle;
- identical number of formal runs and aggregation rule;
- identical tool schemas and trusted restoration topology where applicable.

The only intended experimental dimension is the sensitive-data representation. The Task-aware arm may use the frozen requirement annotations to transform data, but its Agent-visible task description must be byte-identical to the other arms. Oracle and annotation metadata are evaluator-side only.

Any strategy-specific prose, few-shot example, field reordering, schema simplification, or extra task explanation invalidates the comparison as `prompt_or_format_confounded`.

## 7. Pareto and falsification criteria

For each task, compare `(task_success, Agent exposure score)` and retain the full category counts. One strategy Pareto-dominates another on a task if it has no lower utility, no higher Agent exposure, and is strictly better on at least one of those two dimensions.

Evidence supporting the hypothesis requires both:

1. Task-aware shows a Pareto improvement over Stable Tokenization either at comparable utility with lower exposure or at comparable exposure with higher utility; and
2. the improvement repeats in at least two distinct non-equivalent capability families among grouping, ordering, coarse location, cross-record relation, and tool/property disclosure.

`MD-EQ-01` and `MD-GRAPH-06` are controls and are not sufficient evidence by themselves. A win only on one hand-built task is exploratory, not support.

The hypothesis is weakened or rejected for v0.1 when any of the following occurs:

- Stable Tokenization reaches the same utility with equal or lower exposure on at least six of seven tasks.
- Task-aware cannot deterministically derive or correctly render required properties/relations from gold annotations.
- Task-aware requires raw Agent exposure for three or more tasks to preserve utility.
- Task-aware has no Pareto improvement over Stable Tokenization in at least two distinct non-control capability families.
- Apparent gains disappear when prompt wrapper, field order, output schema, and generation configuration are equalized.
- Gains occur only in `MD-TOOL-07` or another single specially constructed fixture.
- Restoration or ledger accounting is strategy-dependent, incomplete, or not auditable.

The result may also be mixed: Stable may be sufficient for identity/equality and graph tasks while Task-aware adds value only for property- or comparison-dependent tasks. That mixed result is an intended, falsifiable outcome.

## 8. Required result table

Every formal report must include at least:

| task_id | strategy | task_success | named relation checks | raw occurrences | raw distinct | coarsened | derived | relation-only | opaque | redacted | Agent exposure | Tool exposure | restore rate | validity |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|

`validity` is one of `valid`, `schema_invalid`, `prompt_or_format_confounded`, `execution_invalid`, or `oracle_invalid`. Invalid observations remain reported and are not silently rerun after outcomes are seen.

## 9. Freeze boundary and implementation readiness

This specification is sufficient to begin a **minimal, local experimental implementation** consisting of fixture loading, three transformations, a disclosure ledger, exact JSON parsing, restoration, and deterministic oracles. It is not yet sufficient for a formal LLM experiment.

Before a formal run, freeze in a new versioned execution manifest:

- exact model/provider/version and availability;
- system prompt and byte-level prompt renderer for each transformed input;
- generation configuration, seed/repetition policy, budgets, timeouts, and retry rules;
- exact token and relation serialization syntax;
- transformation correctness tests from raw fixture to disclosure ledger;
- eligibility, invalid-run, and denominator policy;
- trusted restoration and mock-tool boundary behavior;
- artifact naming and immutable hashes for task data, prompt template, and oracle.

## 10. Credibility blockers still open

1. **Construct validity:** seven synthetic fixtures may overfit the hypothesis. A later version needs independently sourced variants without changing v0.1 after results are seen.
2. **Requirement availability:** v0.1 uses gold task requirements and therefore does not measure whether a real system can infer them reliably.
3. **Disclosure weights:** the ordinal weights are conventional and require sensitivity analysis; claims must survive reporting category counts without the weighted score.
4. **Agent inference:** the ledger measures explicit disclosure, not all background-knowledge inference from coarsened values or relations.
5. **Stable scope:** task-instance scope is frozen here, but alternative session/global scopes could change linkage risk and utility.
6. **Rendering confounds:** relation-only and derived-property inputs may be easier for a model because they precompute work. This is the intended capability treatment, but byte-identical wrappers and control tasks are required to separate it from extra prompting.
7. **Statistical reliability:** no model, repetitions, or variance protocol is frozen yet.
8. **Detection realism:** gold entity spans avoid detector errors; results cannot be claimed as end-to-end privacy protection.
9. **Artifact identity:** a formal run needs immutable file hashes or source-control versioning before results are collected.
