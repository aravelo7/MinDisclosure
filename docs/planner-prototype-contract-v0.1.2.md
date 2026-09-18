# MinDisclosure Planner Prototype Contract v0.1.2

Status: **FROZEN DEVELOPMENT REVISION PROVENANCE PATCH**

This patch is based on the immutable
`planner-prototype-contract-v0.1.1` release at commit
`8d3aeb616a75f20d72a920e6240ed716c6cd8ace`.
Its P0 semantic-identifier leakage closure remains authoritative and unchanged.

This patch closes only the revised-prompt lifecycle and provenance gate. It
does not reopen Planner architecture, raw-blind policy, opaque operation slots,
Planner Spec, ontology, catalog, provider, generation, Runtime, or held-out
design.

## 1. Normative patch artifacts

- `docs/planner-prototype-contract-v0.1.2.md`
- `fixtures/planner-prototype-development-revision-schema-v0.1.2.json`
- `tests/planner-prototype-contract-v0.1.2.test.js`

All other v0.1.1 and v0.1 assets are reused byte-for-byte.

## 2. Immutable initial prompt

Every initial development run uses the exact bytes of:

~~~text
prompts/planner-prototype-v0.1.txt
SHA-256 6832acad77c8182be79bd2aec8f278eb533261bbf939108b5cf52f4a4ac66a5d
~~~

The seven initial runs execute exactly once in frozen task order. A development
decision is inadmissible until all seven initial runs are terminal and one
failure-classification artifact has been completed and hashed.

## 3. Development decision

After initial-batch completion, exactly one decision is recorded:

~~~text
NO_REVISION
ONE_GENERAL_REVISION
~~~

The decision record must validate against
`planner-prototype-development-revision-schema-v0.1.2.json`.

No revised prompt file, diff artifact, revised hash, revised manifest, or
revision rationale may be created before ONE_GENERAL_REVISION is recorded.
This contract itself therefore contains no real revised prompt.

## 4. NO_REVISION

For NO_REVISION, all revised-prompt, diff, rationale, admissibility, and batch
fields are null. No revised prompt artifact may exist and no revised provider
dispatch is permitted. The development protocol ends after the decision record
is frozen.

NO_REVISION is a valid completion state, not a failed or incomplete revised
batch.

## 5. ONE_GENERAL_REVISION lifecycle

ONE_GENERAL_REVISION permits exactly one complete revised prompt artifact:

~~~text
prompts/planner-prototype-v0.1-revised.txt
~~~

Before the first revised provider dispatch, the harness must atomically
complete all of these steps:

~~~text
read exact revised prompt bytes
-> compute revised_prompt_sha256
-> record general_revision_rationale
-> build exact two-sided prompt-diff artifact
-> compute prompt_diff_sha256
-> pass revision admissibility
-> freeze the seven-run revised manifest
-> persist the complete decision/provenance record
-> re-read prompt bytes and verify the frozen hash
-> permit first revised dispatch
~~~

Missing, partial, schema-invalid, non-admissible, or hash-inconsistent records
fail before provider dispatch.

## 6. Exact prompt-diff artifact

The exact diff format is `planner-prompt-exact-diff-v0.1`. Its stored bytes
are UTF-8 JSON with no BOM, no insignificant whitespace, and keys in this exact
order:

~~~json
{"format":"planner-prompt-exact-diff-v0.1","initial_utf8_base64":"...","revised_utf8_base64":"..."}
~~~

The base64 values encode the complete original byte sequences without newline
or Unicode normalization. `prompt_diff_sha256` is SHA-256 over these exact
stored JSON bytes. The verifier decodes both values, checks the frozen initial
hash and recorded revised hash, and then provides a human-readable line diff
for review. The exact two-sided artifact, rather than a platform-dependent
line-diff rendering, is the provenance authority.

## 7. General revision rationale

`general_revision_rationale` is the normative revision-rationale provenance
field and must describe one task-independent semantic or
protocol rule. It may clarify a global rule such as allocating operation IDs
from the opaque slot pool in Task IR order.

It must not identify a seed, prescribe behavior for one task family, reveal a
Gold operation or requirement, name an Oracle action, expose an expected
answer, mention a seed-specific field/output, or provide a complete example.

The rationale and revised prompt are both inputs to the same admissibility
gate.

## 8. Revision admissibility

The evaluator constructs a frozen denylist from evaluator-side v0.2.1 seeds,
the v0.1.1 dev fixture, md-bench-v0.2, and Oracle bridge data. The canonical
sorted denylist and its SHA-256 are recorded before accepting the revision.

Both rationale and revised prompt reject on any of these conditions:

- a semantic task ID or evaluator case ID is present;
- a Gold semantic operation ID or requirement ID is present;
- an Oracle transformation/action ID is present;
- an expected-answer subtree or case-specific answer value is present;
- a seed-specific abstract field reference or exact task instruction is
  present in newly added revision text;
- EQ, GROUP, ORDER, LOC, CROSS, GRAPH, or TOOL is used as a task/case branch
  selector;
- added text contains a complete object/example with both Task IR and
  requirements;
- an example/few-shot block is added; or
- P0 model-visible identifier rules are violated.

Matching uses UTF-8 decoding followed by Unicode NFC for inspection only.
Hashes always use original bytes. Identifier comparisons are ASCII
case-insensitive; exact byte provenance remains case-sensitive.

A revision may clarify a general rule but remains zero-shot. Admissibility
failure is final for this one-revision protocol; it does not authorize another
revision attempt or a fallback prompt.

## 9. Frozen revised batch

The planned revised batch is fixed before its first dispatch:

~~~text
planner-dev-v0.1/revised/001/MD-EQ-01
planner-dev-v0.1/revised/002/MD-GROUP-02
planner-dev-v0.1/revised/003/MD-ORDER-03
planner-dev-v0.1/revised/004/MD-LOC-04
planner-dev-v0.1/revised/005/MD-CROSS-05
planner-dev-v0.1/revised/006/MD-GRAPH-06
planner-dev-v0.1/revised/007/MD-TOOL-07
~~~

All seven manifest entries use `prompt_version=revised` and the same
`revised_prompt_sha256`. The order is identical to the initial batch.

Best-of-N, selective rerun, failure-only rerun, early stopping, task-local
variants, extra cases, omissions, and reordering are invalid.

## 10. Dispatch-time immutability

Immediately before every revised HTTP/provider dispatch, the harness re-reads
the complete revised prompt artifact and requires:

~~~text
SHA-256(current exact bytes) == revised_prompt_sha256
run.prompt_sha256 == revised_prompt_sha256
all earlier revised dispatches used revised_prompt_sha256
run identity == next frozen manifest identity
~~~

Any mismatch aborts before that dispatch. Once the first revised dispatch has
occurred, modifying the prompt cannot create a new batch, prompt version, retry,
or admissible continuation under v0.1.2.

Provider failures do not remove remaining planned runs and do not permit prompt
changes. Existing transport retry rules remain unchanged and retry identical
request bytes under the same logical run identity.

## 11. Provenance

The batch-level decision record includes:

- `initial_prompt_sha256`;
- completed initial run identities;
- `failure_classification_sha256`;
- `general_revision_rationale`;
- `revised_prompt_sha256`;
- `prompt_diff_sha256`;
- `prompt_diff_format`;
- `revision_decided_after_initial_batch=true`;
- `revised_prompt_frozen_before_first_dispatch=true`;
- revised prompt and exact-diff artifact paths;
- admissibility status and denylist hash; and
- the complete revised run manifest.

Every revised run artifact continues to use the unchanged v0.1 run-artifact
schema and records `prompt_version=revised` plus the same frozen
`prompt_sha256`.

## 12. Offline qualification

The v0.1.2 freeze gate uses in-memory scripted prompt bytes only. It creates no
real revised prompt and performs no provider call. It verifies:

- immutable initial prompt hash;
- legal NO_REVISION;
- revised dispatch rejection before complete freeze;
- exact-diff and prompt hash integrity;
- one hash across seven revised identities;
- mutation rejection after first dispatch;
- task-local variant and selective rerun rejection;
- seed-specific rationale, Gold, Oracle, answer, and few-shot rejection;
- unchanged v0.1.1/P0 assets and Planner Spec;
- full repository tests, secret scan, and `git diff --check`.

## 13. Freeze boundary

This release is only a development-revision provenance closure:

~~~text
no real revised prompt
no Planner implementation
no initial or revised dev inference
no DeepSeek call
no research result
no held-out benchmark
~~~

After this freeze, the prototype design phase is complete for the currently
identified P0/P1 blockers. Prototype implementation may begin only as a
separate task implementing these frozen contracts.
