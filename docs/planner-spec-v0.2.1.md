# MinDisclosure Planner Specification v0.2.1

Status: **FROZEN CONTRACT-CLOSURE PATCH**

Version: `planner-spec-v0.2.1`

This patch inherits `planner-spec-v0.2` and closes only its remaining authority
binding, No-Solver structural-verification, and compiler-dimension-selection
gaps. Capability ontology, `AGENT`/`TOOL` boundaries, Task IR semantics,
evaluation semantics, Runtime scope, benchmark data, and formal results are
unchanged.

## 1. Normative artifacts

The v0.2.1 contract consists of:

- this specification;
- `fixtures/planner-capability-schema-v0.2.1.json`;
- `fixtures/planner-seed-cases-v0.2.1.json`;
- `fixtures/planner-representation-catalog-v0.2.1.json`;
- `fixtures/planner-negative-cases-v0.2.1.json`; and
- `tests/planner-spec-v0.2.1.test.js`.

All v0.1 and v0.2 artifacts remain immutable historical objects. Where this
patch is silent, the frozen v0.2 contract remains normative.

## 2. Unchanged architecture and scope

```text
Task
  -> Task IR
  -> Information Capability Requirements
  -> Deterministic Disclosure Compiler
  -> Disclosure Plan
```

The Planner does not select a representation. The compiler receives no raw
sensitive values, task answer, or Oracle mapping. No capability, disclosure
boundary, Runtime component, provider abstraction, or benchmark task is added.

## 3. Authority support compatibility

Source labels and source support declarations are trusted verifier inputs, not
Planner output. Existence of a trusted source is necessary but not sufficient:
the witness support must be compatible with the requirement.

The verifier first checks the v0.2 registry rules: source existence, exact
authority-class equality, an authority-bearing class, and exact
`(support_type, support_ref)` membership. It then applies exactly one rule from
the following closed table.

| Support type | Required class | Machine compatibility rule |
|---|---|---|
| `OPERATION` | `USER_INTENT` | `support_ref == requirement.operation_ref`; every target is an exact input of that operation; the requirement boundary is `AGENT`. |
| `SCHEMA_FIELD` | `DATA_SCHEMA` | `support_ref` equals a requirement target `field_ref`; that target is an exact input of the bound operation; scope is not `DECLARED_TOOL_ARGUMENT`; boundary is `AGENT`. |
| `WORKFLOW_RULE` | `TRUSTED_WORKFLOW` | `support_ref` occurs as an exact structured reference in capability or bound-operation parameters; every target is an exact operation input; scope is not `DECLARED_TOOL_ARGUMENT`; boundary is `AGENT`. |
| `SOURCE_RELATION` | `DATA_SCHEMA` | scope is `DECLARED_RELATION_SET` with `scope.reference == support_ref`; targets are exact `RELATION_SOURCE`/`RELATION_TARGET` inputs of the bound operation; capability is `existing_relation` or `directionality`; boundary is `AGENT`. |
| `TOOL_PARAMETER` | `TOOL_SCHEMA` | the bound operation is `TOOL_EXECUTION/tool_call`; boundary is `TOOL`; scope is `DECLARED_TOOL_ARGUMENT` with `scope.reference == support_ref`; an operation Tool parameter has `parameter_ref == support_ref` and its `source_field_ref` equals the sole requirement target, whose role is `TOOL_ARGUMENT`. |

No compatibility rule is inferred from similar names. A witness that passes
registry lookup but fails this table is `AUTHORITY_WITNESS_INVALID` with primary
diagnostic `AUTHORITY_VIOLATION`. Missing information fails closed.

`UNTRUSTED_CONTENT` and `TOOL_OUTPUT` still cannot support expansion. They may
only provide task data or narrow processing.

## 4. Closed No-Solver structure

The v0.2.1 catalog is a closed object graph. `structural_validation` freezes the
only permitted fields for the catalog, transformation contracts, dimensions,
operation bindings, candidate actions, canonical actions, and coverage entries.
An undeclared field is invalid; there is no free-form action metadata channel.

Every transformation contract binds all of the following:

```text
source_fields
output_fields
source_binding
output_binding
derivation_kind
occurrence_policy
metadata_policy
relation_provenance
source_provenance
canonical_action_templates
required invariants
```

The verifier accepts a transformation only when the complete tuple matches one
frozen `source_output_rules` entry and its invariant values equal that entry.
Boolean declarations therefore cannot independently establish safety.

Additional mandatory checks are:

1. `metadata_policy` is `NO_RUNTIME_METADATA`;
2. each candidate action is byte-semantically equal, after canonical JSON
   serialization, to one declared `canonical_action_template`;
3. field-local outputs preserve source occurrence cardinality and use the
   dimension target fields;
4. stable tokens use the declared stable-equivalence occurrence policy;
5. relation outputs preserve exactly the declared source relation edges and
   require `SOURCE_DECLARED_ONLY` provenance; and
6. every candidate transformation has one valid frozen structural contract.

These rules reject arbitrary metadata, selected subsets or pairs, ranks,
aggregates, graph results, final answers, answer-derived relations, undeclared
output shapes, and source/output provenance mismatches without inspecting
keywords in field names.

## 5. Trusted catalog slice

A `trusted_catalog_slice` is verifier/compiler input and is outside the Planner
document. It contains only:

```text
slice_id
catalog_version
dimension_refs[]
```

It is valid only when:

1. it conforms to `$defs.trusted_catalog_slice`;
2. `catalog_version` exactly identifies the supplied catalog;
3. every `dimension_ref` exists exactly once in that catalog; and
4. the slice was supplied by trusted task/data-schema derivation, never copied
   from Planner output or Oracle metadata.

An absent, wrong-version, unknown, or duplicate dimension reference is invalid
or `INFEASIBLE` with the frozen catalog reason. The Planner cannot choose or
narrow the slice.

## 6. Requirement-to-dimension mapping

For each validated requirement `r`, resolve its bound operation `o` from the
same Task IR. A dimension `d` in the trusted slice matches `r` if and only if:

1. every `(field_ref, semantic_type)` target of `r` is in `d.target_fields`;
2. every target is also an exact `(field_ref, semantic_type, target_role)` input
   of `o`;
3. one `d.operation_bindings` entry contains both `o.family` and `o.role`; and
4. at least one candidate action in `d` declares coverage for the capability
   (or explicit entailment), exact canonical parameters, and exact boundary.

Trusted preconditions are evaluated later during action feasibility; they do
not change dimension identity.

Exactly one dimension must match each requirement. Zero matches in the trusted
slice produce `MISSING_REQUIRED_DIMENSION` when the full trusted catalog has a
match, otherwise `NO_DIMENSION_FOR_TARGET` or
`NO_ACTION_PROVIDES_CAPABILITY`. Multiple matches produce
`AMBIGUOUS_DIMENSION_MAPPING` and invalid input. No arbitrary tie-break is used
for dimension identity.

The relevant dimension set is the validated trusted slice in canonical catalog
order. Each requirement is satisfied only by its uniquely mapped dimension.

## 7. Deterministic compiler contract

The complete compiler input is:

```text
validated Gold or Predicted Capability Requirements and bound Task IR
+ trusted context/source registry and proved claims
+ trusted Task/Data Schema catalog slice
+ Representation Catalog
+ Boundary Policy
```

The compiler performs, in order:

1. validate Planner output, authority witnesses, catalog structure, and slice;
2. compute the unique requirement-to-dimension mapping from Section 6;
3. order slice dimensions by `canonical_dimension_order`;
4. enumerate the complete finite product of listed candidate actions;
5. retain plans whose mapped actions satisfy every requirement, trusted
   precondition, boundary, restoration, authority, and No-Solver rule;
6. return `INFEASIBLE` when none remain;
7. compute the v0.2 Pareto-minimal set; and
8. apply the v0.2 level-vector and canonical-action serialization tie-break.

The algorithm never reads `task_id`, `oracle_bridge.requirement_dimensions`, or
`oracle_bridge.expected_reporting_plan`. For the same finite inputs it produces
the same relevant dimensions, candidate product, feasibility result, Pareto
set, and reporting plan.

## 8. Error and evaluation continuity

The v0.2 canonical evaluator, denominators, error precedence, Gold/Predicted/
Oracle separation, presentation semantics, and seven-seed development-only
status are unchanged. The new structural failures use `ANSWER_LEAKAGE` as the
primary diagnostic when an action attempts an undeclared output or metadata
channel; malformed catalog objects additionally carry
`CATALOG_STRUCTURE_INVALID`.

## 9. Freeze statement

Planner Spec v0.2.1 freezes only:

- support-type compatibility and fail-closed authority witnesses;
- closed transformation/action structure and provenance verification;
- trusted catalog-slice validation;
- unique requirement-to-dimension mapping; and
- compiler independence from seed task IDs and Oracle mappings.

It freezes no Planner implementation, Runtime, provider, model, experiment,
new capability, new boundary, held-out benchmark, or production claim.
