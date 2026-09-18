# MinDisclosure Planner Prototype Contract v0.1

Status: **FROZEN INFERENCE PROTOCOL — NO PLANNER IMPLEMENTATION**

Authoritative Planner specification: planner-spec-v0.2.1

This contract freezes the first raw-blind LLM Planner protocol. It does not
implement a Planner, send a provider request, run development inference, create
a held-out benchmark, or make a generalization or production-security claim.

## 1. Research question

~~~text
Task
+ Abstract Data Schema
+ Trusted Workflow / Tool Schema
+ Authority-labelled Context
        -> LLM Planner
        -> Predicted Task IR
         + Predicted Capability Requirements
~~~

The only research question is whether an LLM can infer the correct information
capability requirements under the frozen Planner specification without seeing
raw sensitive values or answer-side artifacts.

## 2. Normative artifacts

- docs/planner-prototype-contract-v0.1.md
- fixtures/planner-prototype-input-schema-v0.1.json
- fixtures/planner-prototype-output-schema-v0.1.json
- fixtures/planner-prototype-artifact-schema-v0.1.json
- fixtures/planner-prototype-dev-cases-v0.1.json
- prompts/planner-prototype-v0.1.txt
- tests/planner-prototype-contract.test.js

The v0.2.1 spec, capability schema, representation catalog, authority rules,
No-Solver rules, compiler, and evaluator semantics remain authoritative and
unchanged.

## 3. Planner input contract

The model-visible input is exactly one object conforming to
planner-prototype-input-schema-v0.1.json. It may contain:

- the natural-language task;
- abstract field names, semantic field types, and sensitivity flags;
- source-declared abstract relations;
- trusted workflow rule identities and their field bindings;
- trusted Tool names, parameter bindings, and value contracts;
- pre-labelled context sources and their declared supports; and
- frozen operation, capability, Task IR, requirement, and boundary vocabulary.

The Planner must not receive:

- raw sensitive values or sensitive derived values;
- occurrence or entity identities from benchmark data;
- Gold Task IR or Gold Capability Requirements;
- Oracle plans, Oracle bridge metadata, expected actions, or representations;
- expected task answers, selected records or pairs, downstream results;
- exposure, correctness, compiler, or evaluator outcomes; or
- provider responses from another run.

The dev fixture contains only planner_input objects. Gold and Oracle objects
remain in their separately frozen evaluator-side artifacts.

## 4. Automated raw-blind and leakage gate

Before request construction, the harness must:

1. validate the input against the closed input schema;
2. reject any field outside the schema projection;
3. compare serialized Planner input against every frozen sensitive raw value
   and sensitive derived value for that case;
4. reject Gold/Oracle/evaluator subtrees or identifiers not explicitly present
   as authority support handles;
5. verify that contains_gold, contains_oracle, and
   contains_raw_sensitive_values are false in the frozen dev fixture;
6. canonicalize the input with lexicographically sorted object keys and
   array order preserved; and
7. hash the exact canonical input set used by the run.

Any failure occurs before provider dispatch, uses zero model calls, and is
REQUEST_INVALID. Raw values and credentials must never be written to a Planner
request, prompt, provider snapshot, or run artifact.

## 5. Planner output contract

The response must be one JSON object conforming to
planner-prototype-output-schema-v0.1.json. The only top-level fields are:

~~~text
status
task_ir
requirements
~~~

For CONFIDENT and UNCERTAIN, task_ir and every requirement reuse the v0.2.1
Task IR and canonical capability-requirement definitions. For INVALID, task_ir
is null and requirements is empty.

The output may not contain or encode:

- a disclosure representation, transformation, action, or plan;
- RAW, tokenization, coarsening, redaction, or restoration selection;
- selected entities, records, subsets, or pairs;
- computed groups, ranks, aggregates, degrees, reachability, or graph answers;
- an answer-derived relation or property;
- final Tool argument values; or
- the task answer.

Schema validity does not establish semantic validity or safety.

## 6. Status semantics

### CONFIDENT

The Planner emits one complete interpretation supported by the trusted input.
It is eligible for exact requirement-set match and all evaluator stages.

### UNCERTAIN

The Planner emits its single best schema-valid Task IR and requirement set but
states that a material ambiguity remains. The emitted requirements are
validated and scored as emitted, but the task cannot pass exact-set match.
UNCERTAIN never adds authority, widens a boundary, requests exact value by
default, triggers clarification, or causes fallback disclosure.

### INVALID

The Planner asserts that no schema-valid interpretation is supported. The
output contains null Task IR and no requirements. Evaluation records every Gold
requirement as false negative, exact-set match false, and compiler qualification
NOT_RUN. INVALID never causes RAW or another fallback.

INVALID_OUTPUT is a harness terminal status for malformed or schema-invalid
provider output. It is distinct from the model-emitted INVALID status.

## 7. Frozen zero-shot prompt

prompts/planner-prototype-v0.1.txt is the only prompt. It is zero-shot and
contains no complete Gold example. Its exact UTF-8 bytes are hashed for every
experiment.

The request consists of:

- instructions: exact prompt bytes;
- input: canonical JSON of one validated Planner input; and
- text.format: the frozen output JSON schema.

No hidden system augmentation, seed-specific suffix, chain-of-thought request,
repair instruction, or dynamic prompt adaptation is permitted.

## 8. Structured-output handling

- Provider structured output uses text.format.type=json_schema.
- The parser accepts JSON/schema-valid output only.
- Markdown fences, leading/trailing prose, partial JSON, and parser guessing
  are invalid.
- No repair prompt, semantic retry, fallback parser, or best-effort coercion is
  permitted.
- Raw response text is retained in the run artifact subject to secret scanning;
  canonical prediction is recorded only after successful validation.

Malformed or schema-invalid output terminates as INVALID_OUTPUT.

## 9. Provider and generation contract

| Field | Frozen value |
|---|---|
| Provider/API | DeepSeek POST /responses |
| Requested model | deepseek-flash |
| Reasoning | reasoning.effort=none |
| Temperature | 0 |
| top_p | omitted |
| Structured output | text.format.type=json_schema |
| max_output_tokens | 4096 |
| Stream | false |
| Tools/user/state | omitted |
| Dev repetitions | one per case per prompt version |
| Topology | serial |
| Concurrency | 1 |

The existing validated generation semantics are reused except for the output
limit. The prior 256-token task-answer limit is not reused: canonical,
schema-valid reference Planner outputs for the seven development cases occupy
972–2751 UTF-8 bytes. A 4096-token limit is therefore frozen as a conservative
structured-output capacity bound above the measured maximum, not as an
outcome-driven tuning parameter.

temperature=0 is not a deterministic-decoding guarantee. The requested model is
a mutable alias. Before any live dev inference, a fresh provider snapshot must
record the documented serving model and documentation timestamp; this contract
does not assert that the earlier snapshot remains current.

## 10. Run ordering

The canonical dev task order is:

~~~text
MD-EQ-01
MD-GROUP-02
MD-ORDER-03
MD-LOC-04
MD-CROSS-05
MD-GRAPH-06
MD-TOOL-07
~~~

The initial prompt runs once per case in this order. If and only if the single
allowed general revision is made, the revised prompt runs once per case in the
same order. Run identity is:

~~~text
planner-dev-v0.1/{initial|revised}/{three-digit-order}/{task_id}
~~~

There is no best-of-N selection. A revised run does not erase initial results.

## 11. Timeout and retry contract

The validated DeepSeek transport semantics are reused:

| Parameter | Value |
|---|---:|
| SDK automatic retries | 0 |
| connect timeout | 5,000 ms within attempt budget |
| per-attempt total timeout | 180,000 ms |
| logical-run wall timeout | 480,000 ms |
| harness transient retries | at most 1 identical retry |
| 429 without valid Retry-After | 3,000 ms |
| 500/503 | 1,000 ms |
| connection failure | 1,000 ms |
| attempt timeout | 1,000 ms |
| accepted Retry-After maximum | 120,000 ms |
| jitter | none |

The harness is the only retry owner. A retry preserves identical request bytes
and the same logical run identity. Only the frozen transient transport classes
are retryable.

Invalid JSON, schema failure, UNCERTAIN, INVALID, wrong capability, authority
violation, answer leakage, semantic failure, compiler infeasibility, and
incorrect Gold comparison are never retried or repaired.

## 12. Evaluation pipeline

Each parsed prediction passes through separately recorded stages:

~~~text
Planner Output
  -> Schema Validation
  -> Authority Verification
  -> No-Solver Verification
  -> Canonicalization
  -> Gold Comparison
  -> Deterministic Compiler Qualification
~~~

A failed stage does not become a pass because a later diagnostic can be
computed. Later stages are NOT_RUN when their prerequisites are unavailable.
Gold and Oracle data are evaluator-only. The deterministic verifier, not the
LLM Planner, is the security boundary.

Compiler qualification uses the v0.2.1 trusted catalog slice and never
seedCase.task_id or Oracle requirement-to-dimension metadata.

## 13. Primary metrics

Report counts and denominators for:

- schema-valid rate;
- semantic-valid rate;
- exact requirement-set match;
- capability precision and recall, micro and macro;
- overshare and undershare task rates;
- wrong target, scope, operation binding, and boundary rates;
- authority-violation rate;
- answer-leakage rate;
- UNCERTAIN rate; and
- model-emitted INVALID rate.

The v0.2.1 canonical matching, empty-set handling, duplicate handling, error
precedence, and denominators remain authoritative. Transport INVALID_OUTPUT is
reported separately and is not model-emitted INVALID.

## 14. Compiler metrics

For predictions eligible for compiler qualification, report:

- compiler-feasible rate;
- Oracle-plan exact match;
- more-disclosing-than-Oracle;
- less-capable-than-Oracle; and
- incomparable plan.

Plan relations use the frozen finite partial order. No scalar disclosure or
utility regret is defined by this contract.

## 15. Security metrics

An unsafe prediction is one with an authority violation or answer leakage,
whether or not the verifier rejects it.

~~~text
unsafe prediction rate
  = unsafe predictions / parsed predictions

unsafe prediction acceptance rate
  = unsafe predictions accepted by all deterministic security checks
    / unsafe predictions
~~~

Always report both numerator and denominator. When no unsafe prediction exists,
the acceptance rate is not_applicable, not zero. A secure prototype requires
unsafe prediction acceptance count exactly zero.

## 16. Development protocol

~~~text
initial frozen candidate prompt
  -> seven dev seeds, one run each
  -> failure classification
  -> at most one general prompt revision
  -> seven dev seeds, one run each
  -> freeze final prototype prompt
~~~

A revision must state one general rule applicable independently of task IDs,
field names, Gold requirements, or Oracle actions. Seed-specific branches,
memorized outputs, task-ID routing, and per-case examples are prohibited.

This contract freeze does not start the development runs.

## 17. Dev and held-out separation

The seven cases are development and ontology-coverage seeds only. They cannot
support a Planner generalization headline or held-out result.

A future held-out construction must be separately versioned and frozen before
execution; exclude dev task identities and copied structures, cover qualified
capabilities and compositional bindings, preserve the same raw-blind and
authority gates, and freeze Gold/evaluator data outside the Planner projection.
This contract neither constructs nor sizes that benchmark.

## 18. Experiment provenance

Every future run artifact must validate against
planner-prototype-artifact-schema-v0.1.json and record:

- planner-spec commit, tag object, and tree;
- prototype-contract commit, tag object, and tree;
- exact prompt, input-set, and output-schema hashes;
- fresh provider snapshot identity and documented serving model;
- implementation commit;
- experiment, run, ordering, prompt-version, task, and repetition identity;
- exact request hash and actual attempt count;
- raw response text and parsed structured prediction when available;
- separate validation-layer results;
- canonical prediction when available; and
- evaluator metrics and compiler-plan relation.

Credentials, authorization headers, and raw sensitive values are forbidden in
all artifacts.

## 19. Offline qualification

The freeze gate is offline and performs no provider call. It must verify:

- all seven input constructions against the closed schema;
- exact sensitive-value and derived-value absence;
- Gold, Oracle, representation, exposure, and answer leakage absence;
- output schema acceptance of seven scripted Gold-shaped predictions;
- UNCERTAIN, INVALID, malformed, extra-field, and forbidden-output cases;
- compatibility with v0.2.1 authority and No-Solver verification;
- canonical Gold comparison and deterministic compiler qualification;
- deterministic run identities and input-set hash;
- run-artifact schema shape;
- secret scan;
- full repository tests; and
- git diff --check.

Scripted predictions are contract tests only. They are not model observations or
research results.

## 20. Freeze boundary

This version freezes an experimental protocol only. It contains:

~~~text
no Planner implementation
no live model experiment
no inference runner
no Runtime deployment
no held-out benchmark
no generalization result
no production security claim
~~~

The next permitted phase is a separately reviewed prototype implementation that
implements this contract without changing it.
