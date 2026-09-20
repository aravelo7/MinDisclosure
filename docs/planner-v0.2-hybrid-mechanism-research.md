# Planner v0.2 Hybrid Semantic Kernel Contract — mechanism research memo

Status: design research only; not a frozen contract and not an implementation

Repository snapshot inspected: 2026-09-20

Public sources accessed: 2026-09-20

This memo accepts the prior audit result as a premise: the strong mapping
`Task IR + trusted inputs -> fully deterministic Capability Requirements` is
false. In particular, scope, witness choice, Graph requirements, and Tool
exact-value boundary are not generally unique. The proposed contract therefore
uses deterministic completion only for fields whose derivation is defined and
single-valued; it does not add a tie-break to hide semantic ambiguity.

## 1. Prior-art findings

| Source | Core mechanism | Useful for MinDisclosure | What must not be copied or overclaimed |
|---|---|---|---|
| [IntentCap, “LLM Agent Capabilities Should Follow Task Intent and Context Source,” arXiv:2609.14631](https://arxiv.org/abs/2609.14631) ([HTML](https://arxiv.org/html/2609.14631v1)) | A capability lease is composed from separately labeled user intent, workflow, tool schema, and runtime sources. Each decision field has an owner; leases may only narrow authority; an untrusted LLM proposes while a deterministic checker decides before a side effect. | Adopt field-level ownership, source labels outside the Planner, monotonic narrowing, and a deterministic accept/deny point. A tool schema may define an interface field but cannot authorize a destination or task purpose. | The paper reports a preliminary prototype and says copy-witness provenance is conservative and meet-based composition remains future work. It does not prove that a task’s information capability, scope, or MinDisclosure boundary is uniquely inferable. Runtime observations are data inputs here, not authority for creating requirements. |
| [FLOWSEAL, “Confuse the Model, Control the Flow,” arXiv:2609.14003](https://arxiv.org/abs/2609.14003) ([HTML](https://arxiv.org/html/2609.14003v1)) | Source-derived ownership labels, taint propagation, a release lattice, mandatory mediation of every write/share outside the main LLM, and controlled declassification. Its remaining semantic checker is isolated and narrowly invoked. | Keep provenance, release authorization, declassification/restoration, and actual Tool-boundary enforcement outside the Semantic Planner. Treat the boundary as an enforced information-flow fact, not merely a Planner label. | FLOWSEAL protects runtime flows; it does not construct task capability requirements. Its semantic declassification still has model error, so it is not evidence that semantic necessity can be deterministic. MinDisclosure must not claim its formal no-write-down result without the same runtime assumptions and mediation. |
| [ToolMinimize, arXiv:2608.24957](https://arxiv.org/abs/2608.24957) ([HTML](https://arxiv.org/html/2608.24957v1)) | Tool-call middleware distinguishes schema-required fields from functionally necessary content and rewrites arguments through removal, generalization, substitution, and truncation. It offers fail-closed, fail-open, and confirmation modes. | Put argument minimization after semantic and authority validation, at the Tool boundary. Preserve the distinction between “the parameter exists/is required” and “this exact value or precision is task-essential.” Default to fail-closed. | JSON Schema requiredness is only a conservative proxy. The paper reports four end-to-end map failures when required addresses lacked necessity annotations, and uses optional LLM reasoning for free-text necessity. Therefore Tool schema alone must not synthesize `exact_value` or its precision. Curated handlers or `minimum_necessary` annotations would be policy metadata, not task semantics. |
| [Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html), [policy validation](https://docs.cedarpolicy.com/policies/validation.html), and [schema](https://docs.cedarpolicy.com/schema/schema.html) | A request has explicit principal/action/resource/context structure; schema-based validation is separate from authorization; the authorizer evaluates policies and defaults to Deny unless a permit applies, with forbid overriding permit. | Separate the semantic request object, type/schema validation, and authorization decision. Require an explicit positive authorization for every completed requirement and preserve diagnostics independently from semantic equality. | A schema can reject malformed or ill-typed objects but cannot decide that a policy or requested capability matches human intent. Cedar’s policy-level “skip on error” is not suitable as MinDisclosure’s whole-request rule; MinDisclosure should reject an invalid or unresolved kernel rather than silently evaluate the remainder. |
| [UCAN Working Group specification v1.0.0](https://github.com/ucan-wg/spec) | A capability states subject × command × policy, while proofs/witnesses are positive evidence expressed as verifiable delegation chains. Delegation attenuates authority; validation occurs at execution time. The spec warns that a cryptographically valid chain can still be semantically invalid. | Treat a Capability Requirement and the evidence authorizing it as separate objects. Multiple proof chains may authorize the same capability. Validate attenuation and resource ownership without putting proof identity into task-semantic equality. | UCAN is an authorization/delegation format, not a task-understanding or data-minimization model. Its capability “policy” and MinDisclosure’s information capability are not interchangeable, and its proof chains do not supply missing task semantics or confinement. |
| [OpenFGA relationship queries](https://openfga.dev/docs/interacting/relationship-queries), [contextual authorization](https://openfga.dev/docs/modeling/contextual-time-based-authorization), and Google’s [Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | An authorization model plus source-of-truth relationship tuples answers an explicit user–relation–object check. Contextual tuples can participate in a single request without becoming stored truth. Zanzibar separates ACL storage/modeling from authorization checks. | Model proof resolution as checking a completed semantic request against trusted relations/claims, not as asking the authorization store what task requirement to create. Keep stored and request-local evidence distinguishable and provenance-bound. | ReBAC does not infer a task’s capability name, targets, scope, or boundary. Planner-generated contextual tuples would be self-authorization unless independently trusted. Neither OpenFGA nor Zanzibar should be treated as a direct implementation template or as evidence of requirement uniqueness. |

The shared result is a separation principle, not a new component count:

1. probabilistic interpretation may propose task semantics;
2. trusted schemas and registries may complete only declared, functional fields;
3. authority evidence proves that a proposal is permitted but does not define
   what the task means; and
4. release, rewriting, restoration, and side effects require independent,
   fail-closed enforcement.

## 2. Proposed semantic split

### 2.1 Minimal LLM Semantic Kernel

The Planner remains untrusted. It should output Task IR plus only irreducible
semantic choices for each requirement:

```text
kernel requirement
  operation_binding       # semantic operation node, not a chosen string ID
  target_input_selectors  # selected operation input slot(s)
  capability_name
  semantic_parameters     # only parameters marked SEMANTIC_CHOICE
  semantic_scope_intent   # only when scope changes task meaning
  consumer_intent         # AGENT_COMPUTATION or DECLARED_TOOL_PARAMETER(ref)
```

`consumer_intent` states who must be able to use the information. It is not an
instruction to reveal raw data at that boundary. For example, binding a value
to a declared Tool parameter says that the Tool consumes the value; it does not
by itself say that an exact value is necessary or that restoration is allowed.

The Planner must decide requirement existence, operation binding, target input
selection, and capability name because the allowed inputs do not generally make
those choices unique. A global ontology can reject an invalid choice; it cannot
recover the intended one from operation family and field type alone. In the
Graph case especially, identity, existing relation, and directionality are
distinct semantic claims over overlapping fields.

### 2.2 Deterministic Completion

The deterministic builder may fill a field only when the contract supplies a
total, single-valued derivation from legal inputs. Otherwise it terminates
`AMBIGUOUS` or `UNSUPPORTED`.

| Final field | Owner and rule |
|---|---|
| `requirement_id` | Derived identifier. Assign after canonical semantic sorting; never model output and never task-ID-based. |
| `operation_ref` | The Planner chooses the semantic binding. The system assigns operation IDs in canonical topological order and replaces the binding with that ID. |
| `targets[].field_ref` | The Planner selects operation input slot(s); the builder copies the slot’s declared field reference. |
| `targets[].semantic_type` | Deterministically copied from the abstract data schema/selected Task IR input. A conflict is invalid; the Planner does not choose it. |
| `targets[].target_role` | Deterministically copied from the selected Task IR input slot. If the same field has multiple role-bearing slots and the selector does not disambiguate them, return `AMBIGUOUS`. |
| `capability.family` | Deterministically looked up from `capability.name` in the frozen global ontology. |
| `capability.name` | LLM semantic decision. Operation family + role/type is a validation constraint, not a unique constructor. |
| capability parameter | The ontology must label each parameter `OPERATION_DERIVED`, `WORKFLOW_DERIVED`, `RELATION_DERIVED`, `TOOL_CONTRACT_DERIVED`, or `SEMANTIC_CHOICE`. The first four have explicit extractors over their named trusted source; only `SEMANTIC_CHOICE` is emitted by the Planner. Multiple or missing values fail closed. |
| semantic scope | Planner output only where the task distinguishes the denotation. Relation/tool references and any uniquely implied scope kind may be completed from their binding. No `ALL_RECORDS`/`ALL_OCCURRENCES` tie-break is permitted. |
| effective `boundary` | Derived from `consumer_intent`, the verified operation/tool binding, and release policy. Catalog feasibility must not influence it. If more than one effective boundary remains legal, return `AMBIGUOUS`. |
| `authority_witness` | Removed from the semantic requirement. Constructed by an authority resolver as proof metadata, never by the Planner. |

This rule allows a parameter such as an explicit comparison threshold already
present in Task IR to be copied, while refusing to invent a category scheme,
identity stability domain, exactness promise, or workflow rule. The ontology
must contain the general derivation declaration; adding a rule for one task or
one seed is prohibited.

### 2.3 Authority Proof

A single requirement-wide witness is too coarse for multi-source composition.
Use a separate proof object keyed by the canonical semantic requirement hash:

```text
authority_proof
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

The trusted resolver constructs `field_proofs` from the labeled source
registry. The Planner may not name or relabel proof sources. Each semantic or
release field has one declared owner class, although authorization of a whole
requirement may be conjunctive across several classes. A derived field records
the owned inputs used by its deterministic rule.

Recommended ownership:

| Authority source | May contribute | Must not contribute |
|---|---|---|
| `USER_INTENT` | task purpose, requested operation/effect, selected objects, authorized destination, explicit approval | schema types, Tool interface facts, invented workflow mappings |
| `TRUSTED_WORKFLOW` | procedure, trusted transformation/mapping rule, declared semantic ordering, workflow-limited scope | user consent, new destination, broader object set |
| `DATA_SCHEMA` | field existence/type, source-declared relation and orientation, structural cardinality facts | task necessity, operation purpose, release permission |
| `TOOL_SCHEMA` | callable interface, parameter binding/type, trusted minimum-necessity or exactness annotation if the contract explicitly supplies one | user authorization, task purpose, arbitrary destination, exactness inferred merely from `required` |
| global frozen ontology | capability signatures, family mapping, allowed type/role/scope constraints, explicit entailments and generic derivation rules | task-specific choice, seed answer, representation feasibility |

Composition is monotonic: the completed request must be no broader than every
applicable authority envelope. One source cannot substitute for another. A
workflow may narrow a user-authorized object set; it cannot add an object. A
Tool contract may demand a parameter for a chosen operation; it cannot cause
that operation to become user-authorized.

### 2.4 Verifier

The verifier owns decisions, not semantics. It checks:

- schema and ontology validity;
- exact operation/input matching;
- parameter derivation and source ownership;
- proof completeness, compatibility, and monotonic narrowing;
- formal scope denotation and release-boundary policy;
- No-Solver invariants; and
- absence of forbidden answer-side inputs.

Terminal outcomes are disjoint:

- `AMBIGUOUS`: two or more semantically distinct completions remain under the
  declared rules;
- `UNSUPPORTED`: the requested meaning has no vocabulary, typed derivation, or
  trusted Tool contract in the frozen contract;
- `INSUFFICIENT_AUTHORITY`: the semantic request is expressible but lacks a
  complete valid proof or would widen an authority envelope;
- `INFEASIBLE`: a valid, authorized requirement exists but the disclosure
  compiler has no satisfying representation.

None of these may fall back to raw values, a wider scope, an AGENT boundary, or
a catalog-derived requirement.

### 2.5 Disclosure Compiler and current reusable primitives

The compiler receives only validated, authorized Capability Requirements plus
the full frozen representation catalog and verified precondition claims. It
chooses a representation; it does not infer requirements or repair semantics.

Current primitives that can remain on the main path:

| Primitive | Reuse assessment |
|---|---|
| `exactOperationInput` in `src/planner-prototype-implementation.js` | Reuse for exact operation/input matching after deterministic target expansion. |
| `semanticError` | Reuse ontology arity, family/name, allowed scope, role/type, and parameter-key validation. Split authority checking out and add provenance-aware parameter derivation checks. |
| `authorityError` | Reuse its compatibility predicates as the start of proof validation. Do not reuse the single-witness construction or its hard coupling of witness type to `AGENT`/`TOOL`. |
| `slotPolicyError` and `alphaCanonical` | Reuse canonical operation ordering/renaming concepts. Make the system assign final operation and requirement IDs rather than requiring meaningful model-chosen IDs. |
| `noSolverError` and catalog transformation invariant checks | Reuse as an independent safety check; extend by contract only, not by task-specific keywords. |
| `trustedClaims`, `coverageCapabilityMatches`, `dimensionMatchesRequirement`, and `actionSatisfies` | Reuse after semantic/authority acceptance for compiler feasibility. They must not feed backward into capability, scope, or boundary inference. |
| `compilePrediction` | Reuse finite enumeration, coverage checks, Pareto filtering, and deterministic reporting. Its required `trusted_catalog_slice` input and slice-driven mapping are not reusable in the new contract: select/map structurally from the full frozen catalog or fail on zero/multiple matches. |
| current canonical requirement set | Refactor into semantic canonicalization and proof normalization. The current inclusion of authority class/support in requirement equality must be removed. |

## 3. Authority witness recommendation

`authority_witness` should be removed from Capability Requirement semantic
identity and represented as a separate Authority Proof/Provenance object.

Two requirements with identical operation binding, targets, capability,
semantic parameters, semantic scope, and consumer intent are semantically
equivalent even if they have different valid witnesses. Proof answers “may this
request be exercised under this trusted context snapshot?”; it does not answer
“what capability does the task require?”

Proof equivalence should be extensional for evaluation:

```text
proofs p and q are acceptance-equivalent for requirement r
iff Verify(r, p, context, policy) = ALLOW
and Verify(r, q, context, policy) = ALLOW
```

This does not claim that the two proof chains grant identical ambient
authority. Their exact paths and source IDs remain in audit records. It means
only that both discharge the same field obligations for the same narrowed
request. If several valid proofs exist, retain a canonically sorted proof set or
one canonically selected audit proof; do not change semantic identity and do
not report `AMBIGUOUS`. Ambiguity applies when the requirements differ, not
when their evidence paths differ.

The evaluator should therefore expose separate axes:

1. semantic requirement equality;
2. authority-proof validity and coverage;
3. effective release-policy/boundary correctness; and
4. compiler feasibility/minimality.

A semantically correct but unauthorized requirement can receive semantic credit
while failing end-to-end acceptance with `INSUFFICIENT_AUTHORITY`. Exact proof
identity should never be a Gold-match condition. This also removes the present
incentive to guess a particular witness among several legal witnesses.

## 4. Scope / Boundary recommendation

### Scope

The current `scope` field conflates four different things:

| Scope layer | Meaning | Owner |
|---|---|---|
| semantic scope | The population/occurrence/relation over which the task needs a property to hold | Semantic Planner when not uniquely implied; otherwise deterministic completion |
| policy scope | Maximum objects, destinations, uses, and duration authorized by trusted sources | Authority policy and proof |
| execution scope | Concrete runtime instances processed in this invocation | Runtime/enforcer, constrained by semantic ∩ policy scope |
| proof scope | The objects/operations/fields covered by a proof chain or trusted claim | Authority proof metadata |

`ALL_RECORDS` and `ALL_OCCURRENCES` need formal denotations over the abstract
schema (including record identity, duplicate occurrences, joins, and operation
input cardinality). Until those denotations make one choice unique, they remain
semantic alternatives. Lexical ordering, least-disclosure ordering, or current
catalog coverage is not a valid tie-break. `DECLARED_RELATION_SET(ref)` and
`DECLARED_TOOL_ARGUMENT(ref)` can be deterministic only when the operation has
one verified corresponding binding; otherwise they are ambiguous.

### Boundary

Do not ask the LLM to emit bare `AGENT`/`TOOL`. Ask it for the semantic
consumer/use site and derive the effective release boundary under policy:

- `AGENT_COMPUTATION` requires the declared capability to be available to the
  agent, but still does not imply exact value;
- `DECLARED_TOOL_PARAMETER(ref)` binds the need to one verified Tool input;
  the Tool schema supplies interface facts, while user intent authorizes the
  operation/destination and policy decides whether and how release is allowed.

“Exact value restored only at a trusted Tool boundary” is valid only when all
of the following independently hold:

1. task semantics select that Tool operation and parameter binding;
2. a trusted Tool contract states that exact content is functionally necessary
   (schema requiredness alone is insufficient);
3. authority permits that operation, object, and destination;
4. release policy permits restoration and prevents agent observation; and
5. the runtime enforcer can mediate the restoration atomically at the Tool
   boundary.

The builder may then emit `exact_value` at `TOOL`. If exactness is not stated by
a trusted contract, return `UNSUPPORTED` or `AMBIGUOUS`; do not infer it from a
representation that happens to be feasible. If both AGENT and TOOL use sites
are genuinely requested, represent two semantic needs rather than widening one
boundary.

## 5. Proposed v0.2 dataflow

Use one main path:

```text
Task + abstract data schema + labeled trusted context + global ontology
  -> Semantic Planner (untrusted)
  -> Task IR + Minimal Semantic Kernel
  -> Deterministic Completion
       canonical IDs, copied types/roles, family lookup,
       declared parameter extractors, uniquely implied scope/use-site binding
  -> Authority Proof Resolution
       per-field proofs from trusted source registry; no Planner witness
  -> Verifier / Release Policy
       schema + semantics + ownership + monotonic narrowing + No-Solver;
       derive effective AGENT/TOOL boundary or fail closed
  -> Authorized Capability Requirements + separate Authority Proofs
  -> Deterministic Disclosure Compiler
       full frozen catalog, verified preconditions, no feedback to semantics
  -> Disclosure Plan
  -> independent Tool/runtime boundary enforcement
```

The ordering matters. Proof resolution follows semantic completion so it proves
a concrete request rather than creating one. Catalog search follows validation
so feasibility cannot backsolve capability, scope, or boundary. Runtime
enforcement follows compilation because a correct plan document is not itself
mediation.

## 6. Leakage analysis

| Forbidden input | Why the proposed path does not depend on it |
|---|---|
| Gold Capability Requirements | Gold is used only by an evaluator after prediction. Neither Planner, completion, proof resolution, verifier, nor compiler reads it. Semantic choices remain model outputs or explicit fail-closed states. |
| Oracle / `oracle_bridge` | No stage consumes Oracle plans or evaluator-only mappings. Compiler search begins from validated requirements, not expected actions. |
| `trusted_catalog_slice` | It is removed from requirement construction and from the proposed compiler input. The compiler may inspect the full frozen catalog after validation and must map structurally or fail on zero/multiple matches. Current `validateTrustedSlice` is therefore not part of this contract. |
| task-ID mapping or seed rules | IDs are diagnostic/canonical. Completion rules live in the global ontology and are keyed by semantic signatures and trusted source roles, never task ID, seed index, or known answer. Task-qualified catalog identifiers cannot be selectors. |
| answer-side information | Task IR and kernel may express operations and predicates, not computed groups, rankings, selected rows, graph answers, aggregates, or restored arguments. The No-Solver verifier remains independent. |
| raw sensitive values | Planning and completion consume abstract field references/types and trusted declarations. Raw values are transformed or restored only by the later runtime path and never feed back into requirement inference. |
| representation feasibility | Catalog coverage is consulted only after semantic and authority acceptance. It may return `INFEASIBLE`; it may not choose a capability, semantic scope, consumer intent, or effective boundary. |

The global ontology is allowed because it defines general meanings, signatures,
and derivation rules. It becomes leakage if it embeds a task ID, a seed-specific
field-to-answer map, an expected plan, or a value chosen merely because one
catalog action covers it.

## 7. Open questions

The hybrid architecture is viable, but the contract should **not yet be
frozen**. The following are real freeze blockers rather than implementation
details:

1. **Scope denotation:** formally define `ALL_RECORDS` versus
   `ALL_OCCURRENCES`, including duplicates, record identity, multi-input
   operations, and relation endpoints. Without this, semantic equality and
   deterministic completion cannot distinguish two legal scopes.
2. **Boundary and exactness contract:** freeze `consumer_intent`, trusted Tool
   identity, the authority for destination selection, the metadata that proves
   exact-value necessity, and the restoration/non-observation guarantee.
   Ordinary Tool schema requiredness is insufficient.
3. **Ontology parameter ownership:** for every capability parameter, freeze its
   owner category and total derivation function or mark it `SEMANTIC_CHOICE`.
   The current registry lists required parameter names but not their provenance
   or constructor, so deterministic completion cannot be audited.
4. **Evaluation object split:** freeze semantic canonicalization, proof
   normalization, effective-boundary evaluation, and their separate metrics.
   Existing canonicalization includes witness support in semantic equality and
   therefore cannot be retained unchanged.
5. **Compiler mapping without a trusted slice:** specify structural mapping
   from validated targets/operations to the full catalog and its zero/multiple
   match behavior. The current compiler requires `trusted_catalog_slice`, which
   is forbidden as a requirement-recovery mechanism.

No additional prior-art search, heuristic, seed-specific mapping, provider run,
or held-out design is needed to state these blockers. Once they are resolved
normatively, the existing main path can be revised; a parallel framework is not
needed.
