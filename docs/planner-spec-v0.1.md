# MinDisclosure Planner Specification v0.1

Status: **FROZEN SPECIFICATION**
Version: `planner-spec-v0.1`

This document defines a research specification for translating a task and
trusted context into a verifiable Task IR and Information Capability
Requirements. It does not implement a planner, a disclosure compiler, or a
runtime.

## 1. Scope and non-goals

The Planner layer is:

```text
Natural-language Task
  + Abstract Data Schema
  + Trusted Tool Schema
  + Trusted Workflow / Policy Context
    -> Task IR
    -> Information Capability Requirements
```

The next, deterministic layer is:

```text
Capability Requirements
  + Representation Catalog
  + Boundary Policy
    -> Disclosure Plan
```

Planner v0.1 does not choose `RAW_VALUE`, `OPAQUE_TOKEN`, `REDACTED`, or
`COARSENED_VALUE`. It does not inspect raw sensitive values, execute the task,
compute an answer, select a candidate, call a Tool, restore a value, or ask a
second model to choose a representation.

This specification does not redesign the frozen benchmark's sensitive
representation semantics, exposure weights, Agent/Tool distinction, or
trusted Tool restoration. Those definitions remain normative in
`docs/benchmark-spec.md`, `docs/task-cases.md`, and the frozen fixtures.

Explicit exclusions are Runtime implementation, PII detection, Presidio,
encryption, production proxying, browser/MCP integration, multi-agent
communication, memory, UI, provider abstraction, fine-tuning, training,
real-user data, and production compliance claims.

## 2. Planner input and output

The Planner input is a typed projection of trusted context:

- `USER_INTENT` states the purpose of the task.
- `TRUSTED_WORKFLOW` states trusted workflow constraints and semantic order.
- `DATA_SCHEMA` describes available fields and semantic types, without values.
- `TOOL_SCHEMA` describes Tool operation names and parameter types.
- `UNTRUSTED_CONTENT` is task data or retrieved content, not an authority to
  expand disclosure.
- `TOOL_OUTPUT` is a result, not an authority to expand disclosure.

The Planner output is a single JSON document conforming to
`fixtures/planner-capability-schema-v0.1.json`:

```text
Task IR + Information Capability Requirements + uncertainty state
```

It contains no task answer and no raw sensitive value. `task_id` and abstract
field references are evaluation metadata; they are not answers.

## 3. Context authority model

Authority is deliberately semantic rather than a general policy language:

| Context | v0.1 authority |
|---|---|
| `USER_INTENT` | Defines the requested purpose and operation goal. |
| `TRUSTED_WORKFLOW` | Constrains workflow, semantic ordering, and trusted policy. |
| `DATA_SCHEMA` | Describes available fields, relationships, and semantic types. |
| `TOOL_SCHEMA` | Declares structural Tool parameters and types; it may require an exact value at the Tool boundary but does not grant the Agent raw access. |
| `UNTRUSTED_CONTENT` | Supplies task content only; it cannot independently create or enlarge a capability requirement. |
| `TOOL_OUTPUT` | Supplies an observed result only; it cannot independently create or enlarge a capability requirement. |

Prompt injection, instructions embedded in documents, RAG text, or Tool output
cannot override this model. Dynamic re-authorization, human approval, and
clarification protocols are future work, not v0.1 policy language.

## 4. Task IR

Task IR is a minimal semantic representation. Each operation identifies:

- an operation family;
- its input fields and semantic types;
- whether it is Agent reasoning or Tool execution;
- the semantic properties, relations, comparisons, ordering, or aggregation
  it uses; and
- an abstract result shape.

The operation families are intentionally small and cover the current seed set:

`equality`, `deduplicate`, `group_by`, `aggregate`, `sort`, `filter`,
`compare`, `temporal_window`, `record_linkage`, `graph_relation`, `degree`,
`reachability`, `select`, and `tool_call`.

Task IR may describe `group_by(email.domain)`, `compare(timestamp within
72h)`, or `graph_relation(existing directed edges)`. It may not contain a
group total, sorted rank, matched pair, selected ticket, graph result, or final
Tool argument.

Presentation constraints are explicit Task IR metadata, separate from privacy
capabilities. Examples are input-order preservation, first-appearance group
labels, endpoint-based identifier assignment, pair ordering, and trusted
workflow order. JSON object key insertion order is never a semantic source.

## 5. Information Capability Requirements

Each requirement is the semantic tuple:

```text
(field or field set, capability, boundary, purpose)
```

The schema additionally records whether an exact value is required and the
scope over which the requirement applies. A requirement names a semantic
capability, not a representation and not a result.

The v0.1 ontology is:

### Identity family

- `identity`: preserve stable identity across occurrences.
- `equality`: determine whether values/identities are equal.
- `linkage`: link occurrences referring to the same entity.

### Property family

- `domain`: domain-like field property.
- `category`: categorical field property.
- `ordering`: a field property usable for semantic ordering.
- `coarse_temporal`: lower-resolution temporal property.
- `geographic_region`: geographic region property.
- `service_zone`: workflow-defined service zone property.

### Relation family

- `existing_relation`: preserve a relation already explicit in the source.
- `membership`: preserve membership in an explicitly supplied set.
- `directionality`: preserve direction of an existing relation.
- `temporal_comparison`: compare declared temporal values under a task rule.

### Exact-value family

- `exact_value`: an exact value is required at the declared boundary.

This ontology is a capability vocabulary, not a list of transformations. A
capability such as `domain` does not select `DOMAIN_HANDLE`, and `exact_value`
at `TOOL` does not authorize exact value exposure to `AGENT`.

## 6. Boundary model

Planner v0.1 has exactly two disclosure boundaries:

```text
AGENT
TOOL
```

The same field can have different requirements at the two boundaries. For
example, a recipient may require `identity` or `exact_value` at `TOOL`, while
the Agent receives only the minimum reversible token needed for trusted
restoration. `memory`, inter-agent communication, multi-agent, final-output,
and MCP-specific boundaries are outside this version.

## 7. Deterministic Disclosure Compiler contract

The compiler is designed here but not implemented. Its inputs are:

1. a validated capability requirement set;
2. a Representation Catalog that declares which capabilities each existing
   representation provides at each boundary; and
3. a Boundary Policy containing uniformity, restoration, and authority rules.

Its output is either `FEASIBLE` with a Disclosure Plan or `INFEASIBLE` with a
machine-readable reason. The compiler must:

- cover every required capability at its declared boundary;
- avoid treating a representation as a capability unless the catalog says so;
- preserve the existing benchmark's uniform-per-field-dimension rule;
- preserve explicit source relations without deriving answer relations;
- use the existing trusted Tool restoration contract only for declared Tool
  arguments; and
- never use a second LLM to choose a representation.

Feasibility is capability coverage plus the boundary policy. Minimum is the
component-wise partial order already used by the frozen finite representation
space: plan A dominates plan B when A is no more revealing in every dimension
and strictly less revealing in at least one. If multiple feasible plans are
undominated, the deterministic tie-break is the lexicographically smallest
level vector in frozen dimension order, followed by canonical action JSON.
This is a finite reference minimum, not a global privacy optimum.

The frozen benchmark's `RAW_VALUE`, `COARSENED_VALUE`, `DERIVED_PROPERTY`,
`RELATION_ONLY`, `OPAQUE_TOKEN`, and `REDACTED` meanings remain unchanged. The
compiler consumes those definitions; Planner v0.1 does not redefine them.

## 8. Presentation invariants

Presentation semantics must not be confused with disclosure capability:

1. **Presentation-stable ordering.** If order is task-relevant, it is an
   explicit Task IR semantic requirement or trusted workflow constraint. It
   never depends on JSON key serialization or incidental object insertion
   order.
2. **Explicit identifier convention.** Group labels, node labels, and similar
   identifiers use a declared deterministic convention or deterministic
   post-processing. The convention is not a privacy capability.
3. **Semantic/serialization separation.** JSON field order, key spelling, and
   rendering are serialization concerns. Planner requirements describe the
   semantic ordering or relation that the task needs.

The seed fixture records the GROUP and GRAPH first-appearance conventions and
the LOC trusted zone order as presentation/workflow metadata. They do not
appear in the capability set. `MD-LOC-04` remains validity-compromised for
future utility validation because the formal result exposed a shared
renderer/order confound; it is retained here only as a capability-expression
seed.

## 9. No-Solver Rule v0.1

Planner output may contain field-local property requirements, identity/equality
capabilities, identity preservation, semantic ordering, explicit source
relations, boundary declarations, and exact-value requirements at a Tool
boundary.

It must not contain:

- an aggregate result or sorted rank;
- a selected entity, candidate, or Tool recipient;
- a matched pair, degree, reachability result, or computed relation;
- a task answer, answer-equivalent relation, or restoration result;
- raw sensitive values, raw value hashes, or occurrence-specific answers;
- a representation label or transformation action; or
- an authority claim sourced solely from untrusted content or Tool output.

Automatic structural checks must reject answer/result fields, raw sensitive
values, representation/transformation labels, and output structures that encode
computed results. They must also reject requirements whose boundary is outside
`AGENT`/`TOOL`, whose capability is outside the ontology, or whose source
authority is untrusted.

## 10. Uncertainty and fail-closed behavior

Planner v0.1 exposes exactly three states:

- `CONFIDENT`: the Task IR and requirement set are structurally valid.
- `UNCERTAIN`: the planner cannot establish a complete requirement set.
- `INVALID`: the input authority, schema, or output structure is invalid.

`UNCERTAIN` does not automatically add a broader capability, select
`RAW_VALUE`, or expand authority. Clarification, human approval, and
conservative execution policies are future experiments.

## 11. Planner error taxonomy

- `CORRECT`: the predicted requirement set is semantically equivalent to Gold.
- `OVERSHARE`: the prediction adds capability or boundary authority not entailed
  by Gold.
- `UNDERSHARE`: the prediction omits a capability required by Gold.
- `WRONG_CAPABILITY`: the prediction uses a different semantic capability that
  does not satisfy the Gold capability.
- `WRONG_BOUNDARY`: the capability is appropriate but assigned to the wrong
  boundary.
- `ANSWER_LEAKAGE`: the output encodes an answer or answer-equivalent result.
- `AUTHORITY_VIOLATION`: an untrusted context source expands authority or
  requirements.

These labels are not mutually exclusive in diagnostic detail; an evaluation
may report a primary label and additional violation flags. `INVALID` planner
output is an execution/schema failure, not a capability score.

## 12. Planner evaluation contract

For a normalized requirement element `(field_ref, capability, boundary,
purpose, exact_value_required)`, future evaluation reports:

- capability precision;
- capability recall;
- exact requirement-set match;
- overshare rate;
- undershare rate;
- wrong-boundary rate;
- authority-violation rate; and
- answer-leakage rate.

Set matching is semantic and canonicalized; presentation labels and JSON key
ordering do not affect it. The denominator and treatment of invalid/uncertain
predictions must be frozen before a Planner experiment.

Compiler-level metrics are defined symbolically for future work:

```text
Disclosure regret = Predicted disclosure - Oracle disclosure
Utility regret    = Oracle utility - Predicted utility
```

The scalar disclosure/utility aggregation, invalid-case denominator, and exact
link from a predicted plan to the existing oracle metrics require a separate
evaluation freeze. No numeric definition is invented in Planner Spec v0.1.

## 13. Gold, Oracle, and prediction separation

The following are distinct objects:

```text
Gold Task IR
Gold Capability Requirements
Oracle Minimum Disclosure Plan
Predicted Task IR
Predicted Capability Requirements
Predicted Disclosure Plan
```

The future evaluation chain is:

```text
Natural-language Task
  -> Predicted Task IR
  -> Predicted Capability Requirements
  -> Deterministic Compiler
  -> Predicted Disclosure Plan
```

The reference chain is:

```text
Gold Task IR
  -> Gold Capability Requirements
  -> Oracle Compiler/Search
  -> Oracle Minimum Plan
```

The Oracle remains minimum feasible only within the frozen finite
`md-bench-v0.2` transformation space. It is not a global optimum or a
deployable policy.

## 14. Seed scope and freeze validation

`fixtures/planner-seed-cases-v0.1.json` contains seven seed cases derived from
the frozen tasks. It contains abstract schemas, Task IR, Gold capability
requirements, presentation metadata, and a non-Agent-visible bridge to the
existing selected Oracle dimension. It contains no raw input or ground truth.

The freeze tests require:

1. all seven tasks to have valid Task IR;
2. all seven tasks to have non-empty, valid Gold requirements;
3. no raw sensitive value, task answer, or answer-equivalent result in seeds;
4. every Gold capability to map deterministically to an existing Oracle
   dimension/transform reference;
5. complete `AGENT`/`TOOL` boundary semantics;
6. GROUP/GRAPH label conventions to remain outside capabilities;
7. LOC semantic ordering to be explicit and independent of JSON serialization;
8. the schema to pass static structural validation;
9. capability and operation vocabularies to be global rather than task-made;
10. no unnecessary implementation detail to enter the Planner contract.

The seed cases are examples for ontology qualification, not a new utility
benchmark. `MD-LOC-04` is not eligible for future Planner utility validation
without a separately frozen correction.

## 15. Freeze statement

Planner Spec v0.1 is a specification freeze only. It freezes the Task IR,
capability ontology, boundary and authority semantics, compiler contract,
No-Solver invariants, error taxonomy, evaluation metric names, and seven seed
examples. It does not freeze a Planner implementation, a model, a runtime, a
provider, a training procedure, or a production claim.
