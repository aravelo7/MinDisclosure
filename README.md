# MinDisclosure

Task- and Tool-Aware Minimum Disclosure for LLM Agents

**Status: research prototype with a frozen deterministic benchmark, an implemented Planner prototype under development evaluation, and a non-frozen v0.3 design.**

MinDisclosure studies auditable disclosure representations at separate Agent and Tool boundaries. The disclosure layer may transform information, but the downstream solver—not the privacy transformer—must perform the task. The project is not a production privacy runtime or a validated automatic requirement-prediction system.

## Current status

| Area | State | Scope |
|---|---|---|
| `md-bench-v0.2` | Frozen | Deterministic seven-task benchmark, Oracle search, exposure accounting, and No-Solver checks. |
| `llm-contract-v0.1` | Frozen and offline-qualified | Experimental protocol and mock harness; the tracked offline artifact is not a model result. |
| Planner prototype v0.1 | Implemented; development evidence only | Raw-blind prototype, deterministic validation/compiler path, and real-model runs over seven development seeds. These are not held-out or formal Planner results. |
| Planner v0.3 | Draft; not frozen | Hybrid Semantic Kernel specification plus materialized schema, ontology, representation catalog, and conformance tests. No v0.3 Runtime or model evaluation is claimed. |

Oracle MinDisclosure is the minimum feasible disclosure within the frozen finite transformation space. It is a benchmark reference, not a deployable planner or a claim of global minimality.

## Evidence snapshot

The frozen deterministic run covers `7 tasks × 4 strategies` with a reference solver and no model calls:

| Strategy | Successful tasks | Agent exposure score |
|---|---:|---:|
| Fixed Redaction | 0 / 7 | 0 |
| Stable Tokenization | 2 / 7 | 4.55 |
| Oracle MinDisclosure | 7 / 7 | 12.55 |
| Raw Disclosure | 7 / 7 | 38.75 |

All seven search-derived Oracle plans match the corresponding human-authored comparison plans. Weighted exposure is reported descriptively; it is not the Oracle search objective.

The revised Planner development run made seven real provider dispatches over the development seeds. It produced 6/7 schema-valid outputs, 5/7 semantically valid outputs, and 0/7 exact requirement-set matches. One unsafe prediction was detected and rejected. This is negative development evidence about the current requirement-inference quality, not a generalization result. The evaluation replay reused recorded outputs and made no provider calls.

## Offline reproduction

The core repository uses Node.js built-ins and does not require `npm install`. The full test suite also expects PowerShell 7 (`pwsh`) and Git.

```powershell
# Deterministic benchmark; prints JSON and uses no network or model
node src/md-bench-v0.2.js

# Full offline test suite
node --test

# Planner qualification with a fake provider; no network or model
node src/planner-prototype-implementation.js --offline-qualification
```

These commands do not reproduce or start a live-provider experiment.

## Documentation and artifacts

- Benchmark: [frozen specification](docs/benchmark-spec.md), [task definitions](docs/task-cases.md), [fixture](fixtures/md-bench-v0.2.json), [search space](fixtures/md-bench-v0.2-search-space.json), and [deterministic results](artifacts/md-bench-v0.2-results.json).
- LLM protocol: [frozen contract](docs/llm-experiment-contract-v0.1.md) and [offline harness validation](artifacts/llm/md-bench-v0.2-deepseek-flash-contract-v0.1-offline-validation).
- Planner: [frozen v0.2 specification](docs/planner-spec-v0.2.md), [v0.2.1 contract-closure patch](docs/planner-spec-v0.2.1.md), [prototype contract](docs/planner-prototype-contract-v0.1.md), and [development revision provenance patch](docs/planner-prototype-contract-v0.1.2.md).
- Planner evidence: [revised development summary](artifacts/planner-prototype/planner-prototype-v0.1-revised-deepseek-flash-20260918-01/summary.json) and [initial-run evaluation replay](artifacts/planner-prototype/planner-prototype-v0.1-initial-deepseek-flash-20260918-02-eval-replay-02/summary.json).
- Current design work: [v0.3 draft](docs/planner-spec-v0.3-draft.md) and [Hybrid Semantic Kernel research memo](docs/planner-v0.2-hybrid-mechanism-research.md). Historical specifications remain immutable versioned artifacts.

## Benchmark methodology

Each sensitive field family has a finite task-specific chain ordered from less to more revealing. Oracle search enumerates the product space, applies the No-Solver transformer, runs the independent deterministic solver, and retains the component-wise minimum feasible plans accepted by the success oracle.

Failed task runs do not erase privacy exposure: Agent and Tool ledgers record data actually sent, while tool results separately report invocation, structural validity, and correctness. Stable Tokenization remains the primary control for testing whether a task needs properties beyond stable identity and existing source structure.

## Research boundaries

- No production runtime, proxy, detector, policy engine, MCP server, or provider interceptor is claimed.
- Benchmark exposure weights are not presented as a universal privacy metric.
- Deterministic reference-solver output is not presented as an LLM result.
- Planner development seeds do not support a held-out performance or generalization claim.
- The project does not claim that task-aware privacy or privacy–utility minimization is unique to MinDisclosure.

## External prior-art references

The following work informed the research boundary and is not a runtime dependency:

- [Presidio](https://github.com/data-privacy-stack/presidio): configurable detection and anonymization operations.
- [pii-proxy](https://github.com/daslabhq/pii-proxy): stable substitution and round-trip restoration.
- [og-local](https://github.com/outgate-ai/og-local): opaque placeholder substitution and response restoration.
- [Operationalizing Data Minimization](https://github.com/PEACH-Research-Lab/Operationalize-Data-Minimization): privacy transformations searched under a downstream utility constraint.
- [STAMP](https://aclanthology.org/2026.eacl-long.61/): separate task relevance and privacy sensitivity in input protection.
- [AgentDAM](https://proceedings.neurips.cc/paper_files/paper/2025/hash/c9826b9ea5e1b49b256329934a578d83-Abstract-Datasets_and_Benchmarks_Track.html): purpose-specific necessity in end-to-end agent evaluation.
- [Privacy-R1](https://aclanthology.org/2026.acl-long.2130/): adaptive handling of replaceable and task-critical PII.
