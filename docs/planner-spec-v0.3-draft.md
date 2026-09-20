# MinDisclosure Planner Specification v0.3 Draft

Status: **DRAFT — NOT FROZEN**

Version: `planner-spec-v0.3-draft`

This document is the contract-closure draft for a Hybrid Semantic Kernel
Planner. It is not a Runtime, implementation, benchmark freeze, provider
contract, or claim of held-out generalization. All v0.1, v0.2, and v0.2.1
artifacts remain immutable historical objects.

The draft inherits these principles:

```text
raw-blind planning
No-Solver
fail closed
AGENT / TOOL separation
deterministic disclosure compilation
no Gold / Oracle feedback
one main runtime path
```

Normative terms `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, and `MAY` have their
usual specification meanings within this draft.

## 1. Architecture and responsibility boundary

The only proposed path is:

```text
Task + Abstract Schema + Trusted Context + Global Ontology
  -> Semantic Planner
  -> Task IR + Minimal Semantic Kernel
  -> Deterministic Completion
  -> Authority Proof Resolution
  -> Verifier / Release Policy
  -> Authorized Capability Requirements
  -> Deterministic Disclosure Compiler
  -> Disclosure Plan
  -> Runtime Boundary Enforcement
```

There is no parallel planner, verifier, compiler, catalog, or Runtime path.
Existing main-path primitives are to be refactored by responsibility when this
draft is implemented.

The stages have disjoint authority:

| Stage | May decide | MUST NOT decide |
|---|---|---|
| Semantic Planner | Irreducible task meaning | IDs, copied schema facts, proof identity, effective boundary, representation |
| Deterministic Completion | Total single-valued derivations declared by the contract | A semantic tie, authority, representation feasibility |
| Authority Resolver | Proofs that a completed semantic request lies within trusted authority envelopes | Task meaning or a missing requirement |
| Verifier / Release Policy | Validity, authorization, monotonic narrowing, effective boundary | Repair from Gold, Oracle, catalog feasibility, or raw data |
| Disclosure Compiler | Feasible minimum-disclosure representation among global catalog candidates | Requirement inference, semantic repair, release authorization |
| Runtime Boundary Enforcement | Apply the accepted plan and mediate restoration/release | Widen the accepted requirement or fall back to raw disclosure |

Every stage MUST fail closed when its required input is absent, invalid, or
non-unique under the rules below.

## 2. Inputs and trust model

The semantic path may consume only:

```text
Task
Abstract data schema
Trusted workflow
Trusted Tool schema and Tool information contract
Source-declared relations
Trusted labeled source registry
Global frozen operation/capability ontology
Authority and release policy
```

The source labeler, schema issuer, ontology issuer, Tool-contract issuer, and
policy issuer are outside the Planner. The Planner cannot create, upgrade, or
relabel their authority.

The Planner, deterministic completion, proof resolver, and verifier MUST NOT
read any representation catalog before semantic, authority, and release
acceptance has completed. Section 13 defines the compiler's later access to a
global representation catalog.

Raw sensitive values and computed task results are absent from every planning,
completion, proof-resolution, and verification input. Runtime occurrences may
be processed only after compilation and cannot flow backward into these stages.

## 3. Task IR and canonical operation binding

### 3.1 Planner-visible operation graph

The Planner proposes a semantic operation graph. Each operation node contains:

```text
planner_local_ref
operation family
field-to-named-input-slot bindings
semantic operation parameters
dependencies by planner_local_ref
result shape
optional Tool binding
```

`planner_local_ref` is a syntactic binder scoped to one Planner output. It is
not an `operation_id`, does not carry meaning, and is excluded from semantic
identity. The Planner MUST NOT emit final operation IDs.

Named input slots and their `target_role` are declared by the global operation
ontology. A field binding supplies an abstract-schema `field_ref`; its
`semantic_type` is copied from the abstract schema. The Planner therefore does
not emit `semantic_type` or `target_role` in either Task IR inputs or kernel
targets.

An operation signature is valid only when every named slot exists for the
operation family, each field exists in the abstract schema, the copied type is
allowed for that slot, dependencies form a DAG, and any Tool binding matches a
trusted Tool interface declaration.

### 3.2 Canonical operation identity

`Canonicalize(TaskIR, SemanticKernel)` MUST produce one unique deterministic
serialization that is invariant under Planner-local identifier renaming and
equivalent graph labeling. The mathematical reference definition is the
lexicographically smallest canonical JSON serialization in the complete
alpha-equivalence class of the Task IR and Semantic Kernel. Final IDs are
assigned in the resulting canonical operation order:

```text
op.001, op.002, ...
```

An implementation MAY use any deterministic canonical graph-labeling algorithm
that is observationally equivalent to this definition. Exhaustive enumeration
is not required. Small conformance tests MAY use exhaustive enumeration as an
oracle for the reference definition, but a Runtime implementation is not bound
to that algorithm.

An automorphism that changes only local handles is semantic-equivalent.
Operation family, dependency structure, input-slot bindings, semantic
parameters, result shape, Tool binding, and Semantic Kernel bindings are all
canonical semantics and cannot be erased by alpha-renaming. Operation ID
spelling and Planner-local handles never enter semantic equality.

The existing `slotPolicyError` and `alphaCanonical` concepts are the starting
primitives for this rule; v0.3 changes ID assignment from a Planner obligation
to a system obligation.

## 4. Minimal Semantic Kernel

For each proposed need, the Planner emits only:

```text
operation_binding              # planner_local_ref of a proposed operation
target_input_selectors[]       # named slots of the bound operation
capability_request
semantic_scope_intent          # explicit domain or omitted for unique completion
consumer_intent
```

`consumer_intent` is exactly one of:

```text
AGENT_COMPUTATION
DECLARED_TOOL_PARAMETER(parameter_ref)
```

It identifies who must use the information. It does not imply raw disclosure,
exact-value necessity, or an effective `AGENT`/`TOOL` boundary.

### 4.1 Capability request discriminant

Most requirements use:

```text
capability_request:
  origin: TASK_SEMANTIC
  capability_name
  semantic_parameters          # only parameters owned by SEMANTIC_CHOICE
```

There is one narrowly defined alternative, allowed only with
`DECLARED_TOOL_PARAMETER(ref)`:

```text
capability_request:
  origin: TOOL_INFORMATION_CONTRACT
  capability_name: omitted
  semantic_parameters: omitted
```

In that alternative, the trusted Tool information contract supplies the
functional capability and parameters during deterministic completion. This
discriminant resolves an otherwise inconsistent ownership claim: the Planner
selects the Tool consumer, while the trusted Tool contract—not the Planner and
not ordinary schema requiredness—states the Tool's minimum information need.

The Planner MUST NOT use `TOOL_INFORMATION_CONTRACT` origin for
`AGENT_COMPUTATION`, and MUST NOT supply or override the contract-derived
capability. A task that explicitly needs an additional agent-visible semantic
capability emits a separate `TASK_SEMANTIC` requirement.

### 4.2 Planner-owned decisions

The Planner is responsible for:

- whether a semantic need exists;
- the semantic operation binding;
- target input-slot selection;
- a task-semantic capability name;
- parameters marked `SEMANTIC_CHOICE`;
- scope intent when record and occurrence denotations differ; and
- the consumer intent.

Operation family plus field role/type constrains capability validity but does
not uniquely construct a capability. In particular, identity, equality,
linkage, existing relation, and directionality remain distinct choices even
when their fields overlap.

### 4.3 Forbidden Planner fields

The Planner MUST NOT emit:

```text
requirement_id
final operation_id
semantic_type
target_role
capability.family
authority proof, witness source, support type, or support reference
effective boundary
representation or transformation
catalog template or dimension
```

An output attempting to control one of these fields is invalid; the system
does not silently ignore and then repair it.

## 5. Deterministic Completion

Completion is a partial function. It returns one completed semantic
requirement or a fail-closed status; it never selects among distinct meanings.

For every kernel requirement it performs, in order:

1. resolve and canonicalize its operation binding;
2. resolve every selected named input slot;
3. copy `field_ref`, `semantic_type`, and `target_role` from the verified Task
   IR binding, abstract schema, and operation signature;
4. resolve `capability_name` from the task semantic request or the trusted Tool
   information contract;
5. look up `capability.family`, arity, type/role constraints, dimension kind,
   and parameter declarations in the global ontology;
6. derive every non-semantic parameter by its declared rule and copy every
   validated `SEMANTIC_CHOICE` value;
7. complete and normalize semantic scope under Section 6;
8. retain `consumer_intent` without turning it into an effective boundary; and
9. canonicalize the semantic requirement and assign a diagnostic requirement
   ID after sorting.

Final requirement IDs are:

```text
req.001, req.002, ...
```

in canonical semantic-requirement order. They are diagnostic metadata and are
excluded from semantic identity.

Completion MUST NOT inspect authority proof availability, representation
coverage, candidate action levels, or raw values. Zero valid derivations is
`UNSUPPORTED`; more than one distinct valid derivation is `AMBIGUOUS`.

## 6. Formal semantic scope

The v0.2 bare labels `ALL_RECORDS`, `ALL_OCCURRENCES`, and
`DECLARED_TOOL_ARGUMENT` are not v0.3 semantic scopes. Tool parameter selection
belongs to `consumer_intent`.

V0.3 has three semantic domains:

```text
INPUT_RECORD_SET
INPUT_OCCURRENCE_SET
DECLARED_RELATION_SET(relation_ref)
```

### 6.1 Common model

For selected operation input slots `S`, let `O(S)` be the finite multiset of
input occurrences that actually enter those slots. Each occurrence has an
abstract provenance reference to a source record identity when the schema
declares one. Let:

```text
record_id : O(S) -> R
```

be that trusted provenance function. `record_id` is schema/provenance metadata,
not a value inferred from sensitive field contents.

Joins, expansions, or repeated inputs may produce distinct occurrences with
the same record identity. Multiplicity is therefore observable in `O(S)` even
when it is absent from its image in `R`.

### 6.2 `INPUT_RECORD_SET`

The denotation is:

```text
{ record_id(o) | o in O(S) }
```

That is, all distinct source-record identities contributing to the selected
slots. The abstract schema or trusted source model MUST define the record
identity domain and the provenance function. If either is absent or cannot be
verified, `INPUT_RECORD_SET` is `UNSUPPORTED`.

### 6.3 `INPUT_OCCURRENCE_SET`

The denotation is the complete multiset `O(S)`. Every actual input occurrence
is included and multiplicity is preserved. If one record is repeated by a join,
expansion, or duplicate input, one record identity and its N occurrences are
not interchangeable.

### 6.4 `DECLARED_RELATION_SET(ref)`

This scope is permitted only when:

- `ref` identifies a relation in the trusted `DATA_SCHEMA` source model;
- the relation is source-declared rather than computed from the task answer;
- selected input slots are exactly the declared endpoint slots; and
- orientation and any edge-identity/multiplicity semantics are present in the
  relation declaration.

Its denotation is all source edge occurrences in the declared relation,
including declared multiplicity. If duplicate-edge identity is material but
undefined, the scope is `UNSUPPORTED`.

### 6.5 Extensional equivalence normalization

`INPUT_RECORD_SET` and `INPUT_OCCURRENCE_SET` are extensionally equivalent only
when trusted schema/cardinality constraints prove that `record_id` is a
bijection between `O(S)` and its image: every contributing record has exactly
one entering occurrence and no entering occurrence lacks a record identity.

When this proof exists, completion normalizes both to `INPUT_RECORD_SET`. This
is semantic-equivalence normalization, not a privacy or lexical tie-break. If
equivalence cannot be proved and the Planner omitted an explicit scope intent,
completion returns `AMBIGUOUS`.

Policy scope, proof scope, and concrete execution scope are separate objects:

- semantic scope states where the task-required property must hold;
- policy scope states the maximum authorized objects, uses, destinations, and
  duration;
- proof scope states what a proof supports; and
- execution scope is the runtime instance set, constrained by the intersection
  of semantic and policy scope.

None may be substituted for another.

## 7. Capability parameter ownership and derivation

Every capability parameter declaration in the global ontology MUST contain:

```text
owner
derivation_rule_ref
value_schema
```

`owner` is exactly one of:

```text
OPERATION_DERIVED
WORKFLOW_DERIVED
RELATION_DERIVED
TOOL_CONTRACT_DERIVED
ONTOLOGY_DERIVED
SEMANTIC_CHOICE
```

Every non-`SEMANTIC_CHOICE` `derivation_rule_ref` MUST name a total,
single-valued function over its declared trusted inputs for every case in which
the capability is admitted. A missing owner or rule is `ONTOLOGY_INVALID`. A
rule with no value for an otherwise requested capability is `UNSUPPORTED`; two
or more distinct values are `AMBIGUOUS`.

`SEMANTIC_CHOICE` values are selected by the Planner from the parameter's
closed value schema and then validated against Task IR and trusted declarations.
The ontology cannot choose one using catalog coverage.

### 7.1 Current ontology ownership table

| Capability parameter | Owner | Normative derivation or validation |
|---|---|---|
| `identity.stability_scope` | `ONTOLOGY_DERIVED` | Constant `TASK` in this ontology version. |
| `equality.equality_basis` | `SEMANTIC_CHOICE` | Planner chooses `FIELD_VALUE` or `ENTITY_IDENTITY`; operation and schema must support the choice. |
| `linkage.linkage_scope` | `SEMANTIC_CHOICE` | Planner chooses the declared linkage domain; the value must be compatible with semantic scope and operation graph. |
| `domain.granularity` | `OPERATION_DERIVED` | Exact value of the bound operation's declared domain granularity parameter. |
| `ordering.direction` | `OPERATION_DERIVED` | Exact direction of the bound sort/order operation. |
| `ordering.precision` | `OPERATION_DERIVED` | Exact comparison precision declared by the bound operation. |
| `coarse_temporal.granularity` | `OPERATION_DERIVED` | Exact temporal granularity of the bound operation. |
| `service_zone.zone_rule_ref` | `WORKFLOW_DERIVED` | Unique trusted workflow rule explicitly bound to the operation and target slots. |
| `geographic_region.region_scheme_ref` | `WORKFLOW_DERIVED` | Unique trusted region scheme explicitly bound to the operation and target slots. |
| `existing_relation.relation_orientation` | `RELATION_DERIVED` | Orientation of the selected source-declared relation. |
| `existing_relation.relation_source` | `RELATION_DERIVED` | Constant `SOURCE_DECLARED` after the selected relation passes source-declaration verification. |
| `directionality.relation_orientation` | `RELATION_DERIVED` | Orientation of the selected source-declared relation. |
| `temporal_comparison.comparison` | `OPERATION_DERIVED` | Exact predicate of the bound temporal operation. |
| `temporal_comparison.threshold` | `OPERATION_DERIVED` | Exact threshold value and unit of the bound temporal operation. |
| `temporal_comparison.interval_semantics` | `OPERATION_DERIVED` | Exact endpoint semantics of the bound temporal operation. |
| `temporal_comparison.granularity` | `OPERATION_DERIVED` | Exact temporal precision of the bound operation. |
| `category.category_system_ref` | `SEMANTIC_CHOICE` | Planner selects one trusted declared category system. Zero compatible declarations is `UNSUPPORTED`; multiple declarations with no selection is `AMBIGUOUS`. |
| `membership.set_ref` | `SEMANTIC_CHOICE` | Planner selects one trusted declared set. Zero compatible declarations is `UNSUPPORTED`; multiple declarations with no selection is `AMBIGUOUS`. |
| `exact_value` | no parameters | No parameter completion is permitted. |

`category_system_ref` and `set_ref` are not deterministic under the current
trusted source model. A future version MAY change their owner only after adding
a general uniqueness proof; it MUST NOT add a seed- or task-specific mapping.

Task IR parameters such as an aggregation choice or presentation ordering that
are not capability parameters remain operation or presentation semantics; they
do not enter this table merely because an older shared JSON object admitted
their keys.

## 8. Authority field ownership and monotonic composition

The following ownership table is closed:

| Owner | Owns | Cannot authorize or supply |
|---|---|---|
| `USER_INTENT` | task purpose, requested operation/effect, selected objects, intended destination/use, explicit approval envelope | schema type, Tool interface facts, workflow mapping, representation |
| `TRUSTED_WORKFLOW` | trusted procedure, mapping rule, workflow-derived transformation semantics, workflow scope narrowing | user consent, a new destination, a broader object set |
| `DATA_SCHEMA` | field existence/type, source relation, relation orientation, record identity, cardinality and structural facts | task necessity, purpose, release permission |
| `TOOL_SCHEMA` | callable interface, parameter binding/type, and separately signed Tool information contracts | user authorization, task purpose, a destination not selected by the user |
| `GLOBAL_ONTOLOGY` | operation/capability signatures, type/role constraints, parameter owner declarations, generic derivation functions, explicit entailments | a task-specific choice, source fact, representation choice |

Ownership applies both to direct fields and to inputs of deterministic
derivations. One source cannot fill another owner's field. A derived field is
valid only when all of its owned inputs are valid and its global derivation rule
is verified.

Composition is monotonic narrowing. Let each relevant source define an
authority envelope over its owned fields. The completed request MUST be equal
to or narrower than every applicable envelope. Combining sources computes a
conjunctive meet; it never unions their powers. In particular:

- a workflow can narrow selected objects but cannot add one;
- a Tool interface can constrain a parameter but cannot authorize the call;
- a data relation can constrain endpoints but cannot create a task need; and
- untrusted content or Tool output can supply runtime data or narrow work but
  cannot create or widen an operation, target, scope, destination, capability,
  or boundary.

## 9. Authority Proof

`authority_witness` is removed from the Semantic Requirement and from semantic
equality. The separate proof object is:

```text
AuthorityProof
  semantic_requirement_hash
  context_snapshot_id
  field_proofs[]
    claim_path
    owner_class
    source_id
    support_type
    support_ref
    narrowing_relation
  decision
```

`owner_class` is one of the five owners in Section 8. For
`GLOBAL_ONTOLOGY`, `source_id` is the immutable ontology version identifier;
for all other owners it must resolve in the trusted labeled source registry.

`narrowing_relation` is a machine-checkable predicate reference, not prose. Its
allowed forms are:

```text
EXACT_MATCH
SUBSET_OF
DERIVED_BY(derivation_rule_ref)
CONJUNCTIVE_MEET(policy_rule_ref)
```

The authority resolver receives only:

```text
completed Semantic Requirement
trusted labeled source registry and snapshot identity
authority policy
global ontology identity
```

It enumerates zero, one, or multiple valid proof sets. The Planner cannot name
`source_id`, `support_type`, `support_ref`, or witness type.

Zero complete proof sets yields `INSUFFICIENT_AUTHORITY`. One or more complete
proof sets authorize proof validation to continue. The Authority Resolver MUST
NOT inspect or classify missing Tool information contracts, agent
non-observation support, atomic restoration support, or Runtime mediator
compatibility. Those belong respectively to Deterministic Completion and
Verifier / Release / Runtime capability validation.

Multiple valid proofs are not `AMBIGUOUS` because they do not change task
semantics. Proofs are canonically sorted by:

```text
semantic_requirement_hash,
claim_path,
owner_class,
source_id,
support_type,
support_ref,
canonical narrowing_relation
```

This normalization is for audit, reproducibility, and verification only. A
proof's source ID or path MUST NOT affect Gold semantic equality. Exact proof
paths remain auditable even when two proofs are acceptance-equivalent for the
same narrowed requirement.

The compatibility predicates currently embedded in `authorityError` are
reusable, but the single-witness object and its coupling to semantic equality
and effective boundary are not.

## 10. Tool information and effective-boundary contract

### 10.1 Tool information contract

Ordinary parameter existence, a JSON Schema type, or `required: true` does not
prove functional necessity or exact-value necessity. A trusted Tool information
contract is a distinct signed/deployed declaration:

```text
tool_information_contract
  contract_id
  tool_ref
  parameter_ref
  accepted_source_semantic_types[]
  required_capability
    name
    parameters
  minimum_information_semantics
  issuer
  version
```

The contract belongs to the trusted Tool interface source but has support type
`TOOL_INFORMATION_CONTRACT`, distinct from an ordinary parameter declaration.
It declares the minimum information needed for that parameter's function. It
does not authorize the user's operation or destination.

For Tool-only exact restoration, it MUST declare:

```text
required_capability.name = exact_value
required_capability.parameters = {}
minimum_information_semantics = EXACT_SOURCE_VALUE
```

A missing trusted information contract is `UNSUPPORTED`. A contract with more
than one applicable, semantically distinct minimum requirement is
`AMBIGUOUS`. Catalog coverage cannot select among them.

### 10.2 Release-policy evaluation and Runtime capability inputs

Release-policy input contains only trusted decision material:

```text
trusted release rules
trusted authority inputs
bound Tool identity
bound parameter and destination identity
```

It MUST NOT contain a precomputed authorization result. `Verifier / Release
Policy` evaluates the completed semantic request and verified Authority Proof
against those policy inputs and produces the policy decision outputs:

```text
operation_and_destination_authorized
tool_only_release_authorized
```

The trusted Runtime capability declaration is a separate input and contains
only capability facts:

```text
agent_non_observation_supported
atomic_restoration_supported
runtime_mediator_identity
```

The verifier validates that the declared mediator is compatible with the bound
Tool, parameter, restoration method, and release policy. A `*_guaranteed`
assertion is not accepted as an input substitute for that validation. Runtime
capability facts are not Planner claims, authority decisions, or representation
preconditions manufactured from a catalog.

### 10.3 Effective boundary derivation

The Planner never emits `AGENT` or `TOOL`.

```text
consumer_intent = AGENT_COMPUTATION
  -> effective boundary = AGENT
```

This rule exposes only the validated capability/precision, not necessarily a
raw or exact value. Authority must still allow the operation and semantic
scope.

```text
consumer_intent = DECLARED_TOOL_PARAMETER(ref)
  -> effective boundary = TOOL
```

only when all of these hold:

1. the Planner selected that exact consumer intent;
2. Task IR and trusted Tool schema prove the Tool/parameter/source-field
   binding;
3. a trusted Tool information contract supplies the required capability and
   parameters;
4. Authority Proof Resolution produced at least one complete valid proof;
5. release-policy evaluation produced
   `operation_and_destination_authorized = true`;
6. release-policy evaluation produced `tool_only_release_authorized = true`;
7. the trusted Runtime capability declaration states
   `agent_non_observation_supported = true` and
   `atomic_restoration_supported = true`; and
8. the verifier confirms that `runtime_mediator_identity` is compatible with
   the bound Tool, parameter, restoration method, and release policy.

The final derivation therefore depends on:

```text
semantic request
+ authority proof
+ release policy decision
+ trusted Runtime capability declaration
```

Stage ownership is strict. If item 3 is absent, Deterministic Completion has
already terminated `UNSUPPORTED`; release analysis is not run. If item 4 is
absent, Authority Proof Resolution has already terminated
`INSUFFICIENT_AUTHORITY`. At the Verifier / Release / Runtime capability stage,
missing item 7 or 8 is `UNSUPPORTED`; supported capability with item 5 or 6
denied is `INSUFFICIENT_AUTHORITY`. There is no fallback to `AGENT`, raw data,
or a wider scope.

If the same source field is needed for agent computation and Tool exact
consumption, they are two Semantic Requirements with different consumer
intents. A single requirement cannot be widened to cover both.

## 11. Semantic identity and canonicalization

The semantic identity of a completed requirement is exactly:

```text
canonical operation binding
canonical target input selector set
capability name
canonical completed semantic parameters
canonical formal semantic scope
canonical consumer_intent
```

It excludes:

```text
requirement_id
operation ID spelling or Planner-local handle
copied semantic_type
copied target_role
derived capability.family
parameter derivation evidence
authority proof identity or path
effective boundary
representation, dimension, or compiler action
```

Copied and derived values remain mandatory validation inputs; exclusion from
identity means they cannot independently distinguish requirements when their
owning semantic selector is identical.

Targets are sorted by canonical input-slot selector. Parameter objects use
lexicographic keys. Extensionally equivalent scopes normalize under Section
6.5. Consumer Tool parameters use canonical `(tool_ref, parameter_ref)`
bindings, not spelling guessed by the Planner.

The `semantic_requirement_hash` is a versioned hash of the canonical semantic
identity serialization. Proofs and effective-boundary decisions refer to this
hash but do not change it.

## 12. Evaluation split

Evaluation has four independent axes:

1. **Semantic requirement correctness** compares canonical completed Semantic
   Requirement sets. It ignores proof identity, effective boundary, and
   representation.
2. **Authority proof validity/coverage** checks every field obligation,
   compatibility predicate, source ownership rule, context snapshot, and
   monotonic-narrowing relation.
3. **Effective boundary/release-policy correctness** checks consumer intent
   against the independently derived boundary and release/enforcement facts.
4. **Compiler feasibility/minimality** checks representation feasibility,
   Pareto minimality, and deterministic reporting after the first three axes.

Semantic exact-set metrics use only axis 1. Proof IDs, proof paths, source IDs,
effective boundaries, and compiler actions are never Gold semantic exact-match
elements.

A prediction may be:

```text
semantic correct
+ authority invalid
```

It retains semantic credit but fails end-to-end acceptance with
`INSUFFICIENT_AUTHORITY`. End-to-end acceptance requires all four axes to pass.
An invalid later axis cannot retroactively repair or change the semantic score.

Gold semantic requirements, if used by the evaluator, remain evaluator-only.
Gold proofs are unnecessary for semantic matching; proof evaluation is against
the trusted context and policy supplied for that evaluation instance.

The current `canonicalRequirementSet` must therefore split into semantic
canonicalization and proof normalization. Its v0.2/v0.2.1 inclusion of witness
support in semantic equality is not carried forward.

## 13. Global representation catalog and compiler mapping

### 13.1 Prohibition on trusted slices and task-qualified selectors

V0.3 has no `trusted_catalog_slice`. It cannot be used for requirement
inference, completion, compiler dimension selection, or candidate filtering.

Task-qualified identifiers such as:

```text
MD-EQ-01/email
MD-GROUP-02/contact_email
```

are forbidden as selectors in the v0.3 catalog. Templates MUST NOT contain a
task ID, seed ID, Gold requirement, expected action, expected reporting plan,
Oracle mapping, or known field-to-answer mapping.

### 13.2 Representation templates

The global catalog contains closed, task-agnostic templates. Each template
declares:

```text
template_id
dimension_kind                  # FIELD_DIMENSION or RELATION_DIMENSION
applicable semantic types
applicable selector arity/shape
capability coverage
capability parameter predicates
effective boundary coverage
required trusted preconditions
transformation contract
disclosure rank/order
canonical action template
No-Solver invariants
```

Templates describe general transformations such as stable tokenization,
declared property extraction, source-relation preservation, redaction, or raw
retention. They do not identify a task or a task field by name.

`FIELD_DIMENSION` is not limited to ordinary property capabilities. It also
covers identity, equality, and linkage capabilities whose disclosure
representation acts on the selected field inputs themselves. In particular,
`linkage` establishes cross-record linkability for selected fields; it does not
consume or preserve a source-declared relation identity.

`RELATION_DIMENSION` is reserved for a capability whose ontology declaration
requires a verified source-declared relation identity. A capability declared as
`RELATION_DIMENSION` without an admissible, verifiable relation identity
contract is `ONTOLOGY_INVALID`; no Runtime or catalog step may guess or invent
the relation reference.

The global ontology declares the dimension kind for every capability. Missing
or contradictory dimension-kind declarations are `ONTOLOGY_INVALID`.

### 13.3 Deterministic dimension instantiation

After semantic, authority, and release validation, the compiler constructs
dimensions from Authorized Capability Requirements.

For a field capability:

```text
FIELD_DIMENSION key =
  canonical target input selector set
```

For a relation capability:

```text
RELATION_DIMENSION key =
  canonical declared relation ref
  + canonical endpoint selector set
```

The relation key is total only when the capability's ontology contract binds a
verified source-declared relation identity and the selected endpoint slots
match that declaration. A `RELATION_DIMENSION` capability without that total
relation-key constructor is `ONTOLOGY_INVALID`, not a request to infer a
`relation_ref` from catalog feasibility or Runtime data.

Requirements with the same dimension kind and key share one instantiated
dimension. A dimension may therefore carry multiple capability requirements.
Dimension identity is constructed from validated semantics and does not depend
on finding a catalog action.

Instantiated dimensions are ordered by:

```text
dimension_kind order: FIELD_DIMENSION, RELATION_DIMENSION
then canonical dimension key serialization
```

This replaces task-qualified `canonical_dimension_order`.

### 13.4 Candidate action construction

For each instantiated dimension, the compiler evaluates every global template
whose kind, type, and selector shape match. All matching templates contribute
their canonical actions; identical actions are deduplicated by canonical
serialization. Capability, parameter, effective-boundary, precondition, and
No-Solver checks determine whether an action satisfies each attached
requirement.

Multiple representations are compiler search alternatives, not semantic
ambiguity. Multiple matching templates do not create multiple dimensions; they
contribute to the one dimension constructed in Section 13.3. Conflicting
catalog definitions for one canonical action or disclosure rank are
`CATALOG_INVALID`, not a task outcome.

If an instantiated dimension has zero actions satisfying all of its attached
requirements, the result is `INFEASIBLE`.

### 13.5 Search and deterministic reporting

The compiler input is exactly:

```text
validated completed Semantic Requirements
+ valid Authority Proof decisions
+ effective boundaries
+ trusted precondition claims
+ global task-agnostic Representation Catalog
```

The compiler:

1. instantiates and orders dimensions;
2. builds each finite candidate-action set;
3. enumerates the complete finite product;
4. keeps plans satisfying every attached requirement and precondition;
5. returns `INFEASIBLE` when none remain;
6. computes the Pareto-minimal set using per-dimension disclosure rank;
7. selects the lexicographically smallest rank vector in canonical dimension
   order; and
8. breaks any remaining tie by canonical action serialization.

This reporting tie-break chooses among semantically valid representation plans.
It MUST NOT feed back into Task IR, capability, parameter, scope, consumer
intent, authority proof, or effective boundary.

The enumeration, action-satisfaction, Pareto, and serialization logic in the
current `compilePrediction` is reusable. Its `trusted_catalog_slice` dependency,
task-qualified dimension mapping, and requirement inference from action
coverage are removed.

## 14. Fail-closed results

The contract distinguishes:

| Result | Meaning |
|---|---|
| `AMBIGUOUS` | Two or more semantically distinct valid interpretations or deterministic-completion values remain. Multiple proof paths or representation candidates do not count. |
| `UNSUPPORTED` | The frozen vocabulary, derivation contract, trusted Tool information contract, abstract provenance model, or enforcement capability cannot express the requested meaning. |
| `INSUFFICIENT_AUTHORITY` | Semantics are expressible and completed, but proof or release authorization does not cover the request. |
| `INFEASIBLE` | Semantics, proof, and effective boundary are valid, but the global catalog has no satisfying representation plan. |

`ONTOLOGY_INVALID` and `CATALOG_INVALID` identify invalid trusted contract
artifacts rather than task outcomes. They stop evaluation and compilation; they
are never converted into one of the four task results.

The verifier records all detected diagnostics, while the earliest failed stage
controls the end-to-end terminal result. Each stage owns only failures in its
inputs and decisions:

1. **Deterministic Completion:** missing required Tool information contract or
   missing/non-expressible derivation is `UNSUPPORTED`; multiple semantically
   distinct completions are `AMBIGUOUS`.
2. **Authority Proof Resolution:** a complete Semantic Requirement with no
   complete legal authority proof is `INSUFFICIENT_AUTHORITY`. This stage does
   not inspect Runtime enforcement capabilities.
3. **Verifier / Release / Runtime capability validation:** missing agent
   non-observation support, atomic restoration support, or a compatible Runtime
   mediator is `UNSUPPORTED`; existing capability and Runtime support with a
   denied operation, destination, or Tool-only release is
   `INSUFFICIENT_AUTHORITY`.
4. **Disclosure Compiler:** valid semantics, authority, and effective boundary
   with no satisfying representation is `INFEASIBLE`.

A later stage is not run after an earlier terminal result and cannot return a
status for another stage's missing input. No result permits:

```text
fallback RAW
fallback wider scope
fallback AGENT
catalog backsolving
Gold repair
task-specific special casing
```

## 15. Leakage invariants

Before semantic, authority, and release acceptance, the Planner, completion,
proof resolver, and verifier MUST NOT read:

```text
Gold Capability Requirements
Oracle or oracle_bridge
expected reporting plan
trusted_catalog_slice
task-ID or seed-ID mappings
seed-specific rules
representation feasibility or candidate action results
raw sensitive values
computed task answers
```

The representation catalog enters only after the first three evaluation axes
have accepted their inputs. Compiler output cannot be passed back to rerun or
repair an earlier stage.

The global ontology is legal only as task-agnostic semantics. It is leakage if
it contains a task/seed selector, expected requirement, expected action, or a
derivation chosen because it reproduces a known Gold or Oracle result.

The No-Solver rule remains structural. Task IR may describe operations,
predicates, dependencies, and result shapes, but no stage before Runtime may
contain computed groups, selected records, rank encodings, aggregates, graph
answers, derived answer relations, restored arguments, or final task answers.

## 16. Existing main-path primitives

Implementation of this draft should refactor, not duplicate, these primitives:

| Existing primitive | V0.3 responsibility |
|---|---|
| `exactOperationInput` | Validate the expanded target tuple against the bound canonical operation input. |
| `semanticError` | Retain ontology family/name, arity, role/type, scope, and parameter validation after completion; remove authority coupling. |
| `authorityError` compatibility predicates | Move to Authority Proof verification; replace the single requirement-wide witness and boundary coupling with per-field proof obligations. |
| `slotPolicyError` | Validate canonical system-assigned operation IDs, not Planner-chosen IDs. |
| `alphaCanonical` | Canonicalize the complete operation graph plus kernel bindings before assigning IDs. |
| `noSolverError` | Remain an independent structural safety gate. |
| `trustedClaims` | Supply only verified precondition claims to proof/release checks and the compiler. |
| `coverageCapabilityMatches` | Retain explicit coverage and ontology entailment checks after semantic acceptance. |
| `actionSatisfies` | Check all requirements attached to one instantiated global dimension. |
| `compilePrediction` enumeration/Pareto logic | Retain finite enumeration, feasibility, Pareto filtering, and deterministic plan selection; replace slices and task-qualified dimensions with Section 13 instantiation. |
| `canonicalRequirementSet` | Split into semantic canonicalization and proof normalization, with boundary evaluated on its own axis. |

No v0.1/v0.2/v0.2.1 function, fixture, or frozen specification is changed by
this draft.

## 17. Contract-closure decisions

The five research blockers have the following normative resolutions:

| Research blocker | Draft resolution | Closure in this draft |
|---|---|---|
| Scope denotation | Record identities, occurrence multisets, source relation edges, and the only permitted extensional normalization are defined in Section 6. | Resolved normatively |
| Tool exactness and boundary | A distinct Tool information contract, seven conjunctive TOOL-only conditions, consumer intent, and separate effective-boundary derivation are defined in Section 10. | Resolved normatively |
| Capability parameter ownership | Every current ontology parameter has an owner and rule in Section 7; category/set references remain explicit semantic choices. | Resolved normatively |
| Semantic/proof/boundary evaluation | Semantic identity excludes proof and effective boundary; four independent evaluator axes are defined in Sections 11–12. | Resolved normatively |
| Compiler mapping without trusted slice | Task-agnostic templates and structural FIELD/RELATION dimension instantiation replace slices and task IDs in Section 13. | Resolved normatively |

One design tension required an explicit adjustment: a Tool contract cannot both
own exactness and require the Planner to invent `capability_name=exact_value`.
Section 4.1 resolves this with a discriminated `capability_request` origin. The
task selects the Tool consumer; the trusted functional contract supplies the
minimum capability. This is not a second runtime path and does not let Tool
schema requiredness create capabilities.

## 18. Remaining blockers before freeze

There is no remaining unresolved conceptual choice among the five research
blockers. The draft is nevertheless not freeze-ready until the following
machine-verifiable artifacts and evidence exist in a future authorized round:

1. a closed v0.3 schema for Task IR, Minimal Semantic Kernel, completed Semantic
   Requirement, Authority Proof, Tool information contract, effective-boundary
   decision, and the four-axis evaluator result;
2. a frozen global operation/capability ontology containing the owner,
   derivation, input-slot, dimension-kind, and canonicalization declarations
   required by this draft;
3. a task-agnostic global representation catalog with structural validation and
   no task-qualified identifiers;
4. conformance tests proving scope denotation, completion uniqueness, proof
   multiplicity behavior, boundary failure states, leakage denial, and global
   dimension instantiation; and
5. a trusted, machine-checkable Runtime capability declaration for agent
   non-observation and atomic Tool restoration before any TOOL-only exact
   requirement can be accepted.

These are contract materialization and validation blockers, not permission to
implement them in this round. Until they are present and jointly checked, the
status remains `DRAFT — NOT FROZEN`.

## 19. Explicit exclusions

This draft does not:

- implement or modify `src/`, tests, fixtures, prompts, or artifacts;
- modify any frozen specification;
- call a provider or run live inference;
- design a held-out benchmark;
- change a prompt;
- introduce a Runtime path or claim Runtime enforcement exists;
- migrate the seven development seeds;
- choose a representation for any task;
- commit or push itself; or
- authorize Gold, Oracle, trusted slices, task IDs, raw values, or answer-side
  information to enter semantic construction.
