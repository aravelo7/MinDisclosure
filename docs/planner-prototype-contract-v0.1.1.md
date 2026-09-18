# MinDisclosure Planner Prototype Contract v0.1.1

Status: **FROZEN P0 SEMANTIC-IDENTIFIER LEAKAGE PATCH**

This patch is based on the immutable
`planner-prototype-contract-v0.1` release at commit
`adef3313f8dd4ff927ceadb4bff8de9855fd3d12`.
The authoritative Planner specification remains `planner-spec-v0.2.1` at
commit `6b152f738e8b4f1d4a0186a36bb7466e40de88db`.

This document overrides only the model-visible identifier and corresponding
evaluator alpha-renaming rules. Every other v0.1 provider, generation, retry,
status, security, metric, development, and held-out rule remains unchanged.

## 1. Closed leakage path

The v0.1 provider-visible projection included semantic task, schema, context,
and operation identifiers. In particular, USER_INTENT support declarations
listed the Gold operation identifiers and their count. Those strings disclosed
operation decomposition and semantic hints before Planner inference.

No v0.1 artifact is modified. v0.1.1 supersedes v0.1 for future prototype
experiments.

## 2. Normative patch artifacts

- `docs/planner-prototype-contract-v0.1.1.md`
- `fixtures/planner-prototype-input-schema-v0.1.1.json`
- `fixtures/planner-prototype-dev-cases-v0.1.1.json`
- `tests/planner-prototype-contract-v0.1.1.test.js`

The following v0.1 artifacts are reused byte-for-byte:

- `fixtures/planner-prototype-output-schema-v0.1.json`
- `fixtures/planner-prototype-artifact-schema-v0.1.json`
- `prompts/planner-prototype-v0.1.txt`

The output schema already accepts `op.slot.001` under the frozen v0.2.1
operation-identifier grammar. No Planner Spec, output schema, artifact schema,
prompt, ontology, catalog, compiler, benchmark, provider, or generation change
is required.

## 3. Provider-visible projection

The exact provider-visible Planner input is only
`cases[].planner_input` from the v0.1.1 dev fixture, serialized as canonical
JSON with lexicographically sorted object keys and array order preserved.

The following are evaluator-side only and must never enter request bytes:

- `case_id`;
- `evaluator_task_id`;
- fixture role, leakage flags, and identifier-policy metadata;
- Gold Task IR, Gold requirements, Oracle data, and compiler/evaluator results.

No model-visible input contains an `MD-*` task identifier. Abstract field
names and semantic field types remain visible because they are part of the
allowed abstract data schema.

## 4. Opaque schema and context handles

Schema identifiers match `schema.NNN`. Context-source identifiers match
`ctx.slot.NNN`. Their numeric suffixes are local reference identities only and
carry no task, operation, capability, property, or boundary semantics.

The authority class remains visible and authoritative. Workflow rules, Tool
interfaces, parameter names, abstract field names, semantic field types, and
source-declared relations remain visible when they describe the actual trusted
workflow, Tool schema, or abstract data schema.

## 5. Frozen operation-slot pool

Every dev case receives this exact ordered pool:

~~~text
op.slot.001
op.slot.002
op.slot.003
~~~

Three is the smallest common upper bound because the maximum Gold operation
count among the seven development seeds is three. Pool identity, size, and
order are identical for every case and therefore do not disclose a case's
operation count.

Slots have no frozen semantic meaning. A slot never denotes a particular
operation family, role, field, capability, or Tool action.

The Planner assigns slots only by this structural rule:

~~~text
operation at Task IR array index 0 -> op.slot.001
operation at Task IR array index 1 -> op.slot.002
operation at Task IR array index 2 -> op.slot.003
~~~

Used slots must therefore be the shortest prefix of the pool. Unused slots do
not appear in Task IR. Output using a non-pool slot, a repeated slot, or a
non-prefix/order assignment is semantically invalid.

## 6. USER_INTENT authority without Gold decomposition

Every USER_INTENT source exposes the same three OPERATION supports in the same
order. This states only that the user's task may authorize operations the
Planner itself infers. It does not state how many operations exist or what any
operation means.

Authority verification remains fail-closed. For every requirement:

1. `authority_witness.source_id` resolves to an actual supplied source;
2. source authority class and witness authority class are identical;
3. the exact support tuple exists on that source;
4. `authority_witness.support_ref == requirement.operation_ref` for
   OPERATION support;
5. the referenced operation exists in predicted Task IR;
6. targets exactly match inputs of that referenced operation; and
7. all existing workflow, relation, schema-field, Tool-parameter, scope, and
   boundary compatibility rules continue to apply.

A pool slot that is not used by a predicted operation cannot authorize a
requirement. Nonexistent slots, forged sources, wrong authority classes, and
trusted-but-unrelated supports remain invalid.

## 7. Identifier-independent Gold comparison

Operation, requirement, schema, context, and case identifiers are reference
identity, not semantic correctness.

After schema, slot-policy, authority, and No-Solver verification:

1. find a bijection between predicted and Gold operations using every
   correctness-relevant operation field except `operation_id` and local
   reference strings;
2. require dependency edges to be preserved under that bijection;
3. rewrite predicted `operation_ref`, OPERATION witness references, and
   dependencies through the bijection only inside the evaluator;
4. compare requirement targets, roles, operation bindings, capability family,
   capability name, parameters, scope, boundary, authority class, support
   type, and non-operation support reference;
5. ignore `requirement_id`, `operation_id`, `source_id`, `schema_id`,
   and case identifiers as semantic match keys.

No bijection means mismatch. More than one surviving bijection is an ambiguous
comparison and fails closed. Gold identifiers are never injected into Planner
input.

The deterministic compiler consumes the verified predicted Task IR and its
local references directly. Its capability coverage, trusted precondition,
partial-order, Pareto, tie-break, and INFEASIBLE semantics are unchanged.

## 8. Offline closure gate

Before this patch can freeze, automated tests must establish:

- 7/7 canonical provider-visible projections validate against the v0.1.1
  input schema;
- zero semantic task IDs in request bytes;
- zero v0.1 semantic schema/context IDs in request bytes;
- zero Gold semantic operation IDs in request bytes;
- identical slot pool and USER_INTENT operation-support pool for all cases;
- evaluator-side Gold and Oracle objects remain outside the projection;
- opaque Gold-shaped predictions pass unchanged authority compatibility;
- nonexistent, unused, forged, wrong-class, and unrelated supports reject;
- identifier-independent canonical comparison remains exact;
- all seven compiler qualifications remain feasible and Oracle-exact;
- full repository tests, secret scan, and `git diff --check` pass; and
- `planner-spec-v0.2.1` and `planner-prototype-contract-v0.1` remain
  immutable.

Scripted opaque predictions are contract qualification data only. They are not
model observations or research results.

## 9. Freeze boundary

This release is only a P0 experiment-validity patch:

~~~text
no Planner implementation
no live inference
no research result
no Runtime change
no ontology or representation-catalog change
~~~

The next phase may address another separately scoped design correction or,
after review, implement the frozen prototype contract.
