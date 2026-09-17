# MinDisclosure Planner Specification v0.2

Status: **FROZEN SPECIFICATION**
Version: `planner-spec-v0.2`

This document specifies a verifiable contract for translating a task and
trusted context into Task IR and Information Capability Requirements, then
compiling those requirements over the existing finite disclosure space.

It specifies no trained Planner, Runtime, provider, proxy, PII detector, or
production enforcement system.

## 1. Frozen architecture

```text
Task
  -> Task IR
  -> Information Capability Requirements
  -> Deterministic Disclosure Compiler
  -> Disclosure Plan
```

The Planner does not select a representation, inspect raw sensitive values,
execute a task, compute an answer, select a candidate, invoke a Tool, or restore
a value. The compiler uses no model. It selects only from the finite catalog in
`fixtures/planner-representation-catalog-v0.2.json`.

The only disclosure boundaries are `AGENT` and `TOOL`. Gold, Predicted, and
Oracle objects remain distinct. The No-Solver Rule and Context Authority model
remain mandatory.

This version does not change `md-bench-v0.2`, `llm-contract-v0.1`, the formal
140-run artifacts, or any v0.1 object.

## 2. Normative artifacts

The v0.2 contract consists of:

- this specification;
- `fixtures/planner-capability-schema-v0.2.json`;
- `fixtures/planner-seed-cases-v0.2.json`;
- `fixtures/planner-representation-catalog-v0.2.json`;
- `fixtures/planner-negative-cases-v0.2.json`; and
- `tests/planner-spec-v0.2.test.js`.

The JSON artifacts are normative where prose and machine-readable fields
overlap. The v0.1 artifacts remain immutable historical objects.

## 3. Planner input authority

Every context source is labeled before it reaches the Planner or verifier:

| Authority class | May support a disclosure requirement | Role |
|---|---:|---|
| `USER_INTENT` | yes | Requested operation and goal |
| `TRUSTED_WORKFLOW` | yes | Trusted workflow rule and semantic order |
| `DATA_SCHEMA` | yes | Available field, relation, type, or trusted constraint |
| `TOOL_SCHEMA` | yes | Declared Tool operation and parameter contract |
| `UNTRUSTED_CONTENT` | no | Task data only |
| `TOOL_OUTPUT` | no | Observed result only |

`UNTRUSTED_CONTENT` and `TOOL_OUTPUT` may supply data and may narrow processing.
They cannot independently create a requirement, widen a boundary, add a target,
or strengthen a capability.

Source labels belong to the trusted verifier input. They are not generated or
reclassified by the Planner.

## 4. Task IR v0.2

Each Task IR operation has:

```text
operation_id
family
role
inputs(field_ref, semantic_type, target_role)
parameters
depends_on
result_shape
optional Tool binding
```

The operation families remain:

```text
equality, deduplicate, group_by, aggregate, sort, filter, compare,
temporal_window, record_linkage, graph_relation, degree, reachability,
select, tool_call
```

Task IR describes operations, dependencies, comparison parameters, and result
shape. It may describe a grouping key, an ordering direction, a temporal
threshold, a source-declared graph, or a Tool parameter binding. It may not
contain a computed group, rank, pair, selected record, graph answer, aggregate,
restored argument, or task answer.

Operation parameters are deliberately bounded. Temporal operations can express:

```text
granularity
comparison
threshold(value, unit)
interval_semantics
```

No general temporal or policy language is introduced.

## 5. Canonical capability requirement

The authoritative v0.2 requirement form is:

```text
requirement_id
operation_ref
targets[]:
  field_ref
  semantic_type
  target_role
capability:
  family
  name
  parameters
scope:
  kind
  optional reference
boundary
authority_witness
```

`operation_ref` must identify an operation in the same Task IR. Every target
must be an input of that operation with the same field type and target role.

There is no machine-scored free-text purpose. Operation binding and structured
parameters carry the semantics previously overloaded onto `purpose`.

`capability=exact_value` is the sole authoritative exact-value signal. The
v0.1 `exact_value_required` flag is removed. A v0.2 requirement containing that
legacy flag is invalid.

## 6. Capability semantics registry

The registry in the representation catalog is normative. Every capability
declares:

```text
family and name
qualification state
arity
allowed target roles
applicable semantic types
required parameters
allowed scopes
AGENT and TOOL semantics
satisfaction conditions
explicit entailments
explicit non-entailments
```

The ontology is unchanged.

### 6.1 Identity family

- `identity`: stable identity across the declared scope;
- `equality`: equality testing under a declared basis; and
- `linkage`: cross-occurrence or cross-record linkage under a declared scope.

These capabilities do not automatically entail one another. A catalog action
must explicitly declare each supported capability. This prevents a token that
supports one equality test from being treated as general entity linkage.

### 6.2 Property family

- `domain`: declared domain granularity;
- `category`: a category system named by trusted context;
- `ordering`: order at a declared direction and precision;
- `coarse_temporal`: a declared temporal bucket;
- `geographic_region`: a region under a declared trusted scheme; and
- `service_zone`: a zone under a declared trusted workflow rule.

`ordering`, `coarse_temporal`, and `temporal_comparison` are distinct.
Observing a year bucket does not by itself prove exact ordering or a threshold
comparison.

### 6.3 Relation family

- `existing_relation`: a relation explicitly present in the source, including
  its declared orientation;
- `membership`: membership in a trusted declared set;
- `directionality`: ability to distinguish relation orientation; and
- `temporal_comparison`: evaluation of the declared temporal predicate.

`existing_relation` does not automatically entail `directionality`. The
catalog must declare both if an action supports both.

### 6.4 Exact-value family

- `exact_value`: the exact value reaches the declared boundary.

Exact access does not automatically entail domain, service-zone, linkage, or
other semantic capability. Such coverage requires an explicit catalog entry
and any trusted rule needed to derive it.

## 7. Ontology qualification

The seven development seeds qualify:

```text
identity
equality
linkage
domain
ordering
service_zone
existing_relation
temporal_comparison
exact_value
```

The following remain present but are marked `unqualified-in-v0.2`:

```text
category
coarse_temporal
geographic_region
membership
directionality
```

An unqualified capability is valid vocabulary but has no Gold seed evidence in
v0.2. Qualification is not a claim of generalization.

## 8. Trusted preconditions

Representation coverage is determined only by:

```text
representation contract + proved trusted preconditions
```

A precondition is a named claim in a pre-labeled trusted context source. The
compiler verifies its presence; it does not inspect raw values to manufacture
the claim.

Examples in the current catalog:

- `BIRTH_YEAR` provides year-precision ordering only when
  `DOB_YEAR_ORDER_PRESERVING` is proved;
- `HOUR_BUCKET` provides the frozen 72-hour comparison only when
  `TIMESTAMPS_HOUR_ALIGNED` is proved;
- `SERVICE_ZONE` requires `ZONE_RULE_AVAILABLE`;
- `RELATION_ONLY` requires `SOURCE_RELATION_DECLARED`; and
- reversible `STABLE_TOKEN` at `TOOL` requires a declared Tool argument and
  trusted restoration.

If a precondition is absent, that action does not cover the requirement. The
compiler may select another explicitly covering catalog action. If none exists,
the result is `INFEASIBLE` or the Planner may have already returned
`UNCERTAIN`. No fixture coincidence is a proof.

## 9. Authority witness contract

Every requirement carries:

```text
source_id
authority_class
support_type
support_ref
```

The verifier accepts a witness only if:

1. `source_id` exists in the trusted source registry;
2. the registry class equals `authority_class`;
3. the class is one of the four authority-bearing classes;
4. the source explicitly lists the same support type and reference; and
5. the support is compatible with the bound operation, field, workflow rule,
   source relation, or Tool parameter.

An untrusted source relabeled by the Planner fails step 2. A trusted-looking
identifier with no registry entry fails step 1. A Tool schema cannot authorize
an unrelated operation or destination merely because it accepts a similarly
named field.

Failure is closed and produces `AUTHORITY_WITNESS_INVALID` plus the primary
diagnostic `AUTHORITY_VIOLATION`.

## 10. Representation Catalog

The catalog reuses the finite action chains of `md-bench-v0.2`. It does not
define a second transformation system.

For each dimension it freezes:

- task-qualified dimension identity;
- field and semantic type mapping;
- ordered candidate actions;
- canonical action JSON;
- boundary-specific capability coverage;
- capability parameters and trusted preconditions; and
- privacy level.

Globally it freezes:

- capability semantics;
- transformation invariants;
- canonical dimension order;
- deterministic serialization;
- restoration policy; and
- infeasibility reason codes.

`MD-GRAPH-06/source_relations` is a single-action structural dimension for the
already supplied source relation. It preserves no computed graph result.

## 11. No-Solver transformation invariants

Each transformation contract declares:

```text
source_fields
output_fields
field_local
occurrence_local
uniform_across_records
preserves_existing_relation
depends_on_task_answer
selects_subset
introduces_rank
introduces_aggregate
introduces_derived_relation
source_provenance
```

Allowed actions are uniform field-local property extraction, stable identity
tokens, trusted coarsening, raw retention already present in the frozen space,
redaction, and source-declared relation preservation.

The following are invalid regardless of their label:

- answer-dependent record selection;
- a prefiltered subset;
- rank encoding;
- matched-pair encoding;
- aggregate, degree, reachability, or argmax output;
- answer-dependent derived property;
- non-uniform occurrence treatment serving the answer; and
- a relation not declared in the source.

The verifier checks invariants, not transformation names or keyword blacklists.
Semantic negative fixtures exercise these paths.

## 12. Deterministic compiler

### 12.1 Inputs

```text
validated Gold or Predicted Capability Requirements
+ Representation Catalog
+ Boundary Policy
+ verified trusted precondition claims
```

The compiler never receives raw sensitive values, task answers, or Oracle
selected actions.

### 12.2 Requirement satisfaction

For requirement `r`, mapped dimension `d`, and candidate action `a`, `a`
satisfies `r` if and only if all conditions hold:

1. `r` is semantically valid under the capability registry;
2. `d` covers all target fields and semantic types of `r`;
3. `a` declares a coverage entry for the capability or an explicitly registered
   entailment;
4. all required parameters match after canonicalization;
5. the coverage boundary equals the requirement boundary;
6. arity, target roles, and scope are permitted;
7. every listed trusted precondition has a valid proof;
8. the authority witness is valid; and
9. the transformation satisfies every No-Solver invariant.

String equality of capability names alone is insufficient. An undeclared
semantic implication is never assumed.

### 12.3 Plan feasibility

A plan chooses exactly one catalog action per task dimension. A plan is
`FEASIBLE` if and only if:

- every requirement is satisfied by its mapped dimension action;
- every dimension uses a listed candidate action;
- the uniform-per-dimension policy holds;
- Tool restoration is used only for a declared Tool argument; and
- no action violates authority or No-Solver rules.

If no complete plan is feasible, output is:

```json
{"status":"INFEASIBLE","reasons":["machine-readable-code"]}
```

`RAW_VALUE` is an ordinary catalog candidate. It is never injected as fallback
and supplies only coverage explicitly listed for its dimension.

### 12.4 Pareto minimum

Within the complete finite candidate product, plan A dominates B when A has a
level no greater than B in every dimension and a strictly smaller level in at
least one dimension.

All undominated feasible plans are Pareto-minimal. Weighted exposure is not a
selection objective.

### 12.5 Deterministic reporting plan

Only when more than one Pareto-minimal plan exists, select:

1. the lexicographically smallest level vector in canonical dimension order;
2. then the lexicographically smallest canonical action serialization.

Object keys are lexicographic, dimension actions follow frozen dimension
order, UTF-8 is used, and whitespace is omitted. These rules produce one
reporting plan without asserting a unique privacy optimum.

## 13. Canonical requirement semantics

Before evaluation:

1. validate schema and semantic registry constraints;
2. canonicalize operation and field references without renaming them;
3. sort target arrays by `(field_ref, target_role, semantic_type)`;
4. serialize parameter objects with lexicographic keys;
5. canonicalize scope and boundary enum values;
6. retain authority class and witness support class in the comparison element;
7. sort requirements by their canonical semantic serialization; and
8. reject duplicate canonical requirements as `SEMANTIC_INVALID`.

`requirement_id` is diagnostic metadata and is not part of semantic equality.
The evaluator comparison element is:

```text
operation_ref
canonical targets(field_ref, semantic_type, target_role)
capability family and name
canonical capability parameters
canonical scope
boundary
authority class
witness support type and support reference
```

Two requirements match only when every element above matches.

## 14. Error taxonomy and precedence

Primary errors are evaluated in this order:

1. `ANSWER_LEAKAGE`
2. `AUTHORITY_VIOLATION`
3. `SEMANTIC_INVALID`
4. `WRONG_OPERATION_BINDING`
5. `WRONG_TARGET`
6. `WRONG_SCOPE`
7. `WRONG_BOUNDARY`
8. `WRONG_CAPABILITY`
9. `UNDERSHARE`
10. `OVERSHARE`
11. `CORRECT`

`WRONG_TARGET` includes field, semantic type, or target-role mismatch.
`SEMANTIC_INVALID` includes contradictory parameters, duplicate requirements,
legacy exact flags, invalid arity, and impossible family/name combinations.

One primary error is recorded per diagnosed item or task according to the
evaluator output level. Additional findings remain secondary diagnostics and do
not increment another primary-error counter.

Schema-invalid output is an execution/format failure. Security diagnostics for
authority violation or answer leakage are still reported independently when
detectable.

## 15. Evaluation denominators

Let `G_t` and `P_t` be canonical Gold and Predicted requirement sets for task
`t`.

- `TP_t = |G_t intersect P_t|`
- `FP_t = |P_t minus G_t|`
- `FN_t = |G_t minus P_t|`
- per-task precision is `TP/(TP+FP)`;
- per-task recall is `TP/(TP+FN)`; and
- task exact-set match requires `P_t = G_t` and `CONFIDENT`.

For an empty denominator, the score is 1 only when both Gold and prediction are
empty; otherwise it is 0. Gold sets in the current seeds are non-empty.

Micro precision and recall use summed TP, FP, and FN across all tasks. Macro
precision and recall are the arithmetic mean of per-task values over all tasks.

Handling rules:

- a structurally valid `UNCERTAIN` prediction is scored as emitted but cannot
  pass task exact-set match;
- `INVALID` contributes every Gold requirement as FN, no recoverable predicted
  requirement, and a failed exact-set match;
- an empty `CONFIDENT` prediction contributes every Gold requirement as FN;
- duplicate canonical requirements make the prediction semantically invalid;
- authority-violation and answer-leakage rates use all evaluated tasks as their
  denominator and are independent of capability TP/FP/FN; and
- overshare and undershare rates report tasks with at least one corresponding
  primary or secondary diagnostic divided by all evaluated tasks.

Scalar disclosure regret and utility regret remain outside this freeze. The
finite partial-order result and existing benchmark utility result must be
reported separately until a later evaluation contract defines a scalar.

## 16. Gold, prediction, and Oracle separation

Distinct objects remain:

```text
Gold Task IR
Gold Capability Requirements
Predicted Task IR
Predicted Capability Requirements
Oracle Minimum Disclosure Plan
Predicted Disclosure Plan
```

The seed `oracle_bridge` is evaluator-only mapping metadata. It is not Planner
input and never supplies a representation or selected action to the Planner.

The Oracle remains minimum feasible only in the frozen finite transformation
space. It is not a production policy or global optimum.

## 17. Presentation semantics

Presentation and disclosure capability remain separate.

- GROUP labels follow source appearance order as a presentation convention.
- GRAPH node labels follow endpoint appearance order as a presentation
  convention.
- LOC order is an explicit trusted workflow/operation rule and never JSON key
  order.
- JSON field order, spelling, and rendering are not capability evidence.

`MD-LOC-04` remains renderer/order-confounded for the previous utility
experiment. It is retained only as a capability-expression development seed.

No group label, node label, or serialization token enters the capability
ontology.

## 18. Seed status

The seven cases in `planner-seed-cases-v0.2.json` are development and ontology
coverage seeds only. They verify expressibility, authority witness handling,
catalog feasibility, presentation separation, and continuity with the v0.1
research semantics.

They must not be used to report Planner generalization performance. A future
held-out/compositional evaluation requires a separate freeze.

## 19. Related-work boundary

The following are not standalone MinDisclosure contribution claims:

- task-aware minimization;
- Tool-argument necessity analysis;
- context-source authority;
- deterministic capability checking;
- minimum-disclosure search;
- privacy partial orders; and
- generic Tool-boundary enforcement.

The bounded research focus is:

```text
Task semantics
  -> verifiable information capability requirements
  -> deterministic boundary-specific minimum disclosure
```

The specification makes no priority or exclusivity claim over ToolMinimize,
IntentCap, Operationalizing Data Minimization, or other adjacent work.

## 20. Scope exclusions

This freeze excludes Planner implementation, model calls, training, Runtime,
PII detection, proxying, MCP, multi-agent communication, memory, UI, provider
abstraction, large-scale benchmark generation, prototype experiments, and
production or compliance claims.

## 21. Freeze statement

Planner Spec v0.2 freezes:

- structured Task IR parameters and operation binding;
- capability signatures, qualification, and explicit non-entailments;
- canonical requirement form;
- trusted preconditions and authority witnesses;
- No-Solver transformation invariants;
- the finite representation catalog;
- compiler feasibility, Pareto minimum, and tie-break rules;
- exact-value consistency;
- canonical evaluator matching and denominators;
- error precedence;
- presentation separation; and
- seven development seeds plus semantic negative fixtures.

It freezes no Planner implementation, trained model, Runtime, provider,
production policy, or generalization result.
