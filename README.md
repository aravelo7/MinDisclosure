# MinDisclosure

Task- and Tool-Aware Minimum Disclosure for LLM Agents

**Status: Research Seed / `md-bench-v0.2` Deterministic Benchmark Freeze**

## Problem

Conventional PII redaction removes information without asking which information a task actually needs. Stable tokenization changes sensitive surface values into stable opaque tokens while leaving non-deleted source structure intact. This project studies auditable disclosure representations at separate Agent and Tool boundaries while requiring the downstream solver—not the privacy transformer—to perform the task.

## Hypothesis

For tasks that require a sensitive property beyond stable identity and existing source structure, an oracle minimum-disclosure representation may preserve Raw Disclosure utility while exposing fewer raw values. Stable Tokenization remains the primary control. This is a benchmark hypothesis, not an evaluated system claim.

## Version status

`md-bench-v0.1` is the historical initial specification. Its deterministic validation exposed an answer-leakage risk: several Task-aware representations encoded ranks, matching pairs, groups, graph answers, or a selected tool target rather than leaving the downstream task to the solver.

`md-bench-v0.2` freezes the deterministic benchmark methodology and introduces:

- the No-Solver transformation contract;
- Raw Disclosure as a utility/exposure control;
- search-derived Oracle MinDisclosure;
- Stable Tokenization strong controls;
- separate Agent and Tool boundary exposure accounting; and
- failed-run privacy exposure accounting.

Oracle MinDisclosure means the minimum feasible disclosure within the frozen finite transformation space. It is an oracle benchmark reference, not a deployable method, automatic requirement predictor, or claim of global minimality.

No formal LLM evaluation results are included yet.

## Non-goals

- Building a production runtime, proxy, adapter, detector, policy engine, MCP server, or provider interceptor.
- Claiming that the benchmark exposure weights are a universal privacy metric.
- Evaluating PII detection or requirement-prediction quality; entities and requirements are gold-annotated.
- Presenting deterministic reference-solver output as an LLM result.
- Claiming that task-aware privacy, task-critical PII, or privacy–utility minimization is unique to this project.

## Benchmark-first methodology

Each sensitive field family has a finite task-specific chain ordered from less to more revealing. Oracle search enumerates the product space, applies the No-Solver transformer, runs the independent deterministic solver, and retains the component-wise minimum feasible plans accepted by the success oracle. Weighted exposure is reported but is not the search objective.

The original human-authored disclosure plan remains a comparison artifact. In the seven frozen tasks, every search-derived selected plan matches that plan. Failed task runs do not erase privacy exposure: Agent and Tool ledgers record data actually sent, while tool results separately report invocation, structural validity, and correctness.

The frozen specification is in [docs/benchmark-spec.md](docs/benchmark-spec.md), task definitions are in [docs/task-cases.md](docs/task-cases.md), the fixture is in [fixtures/md-bench-v0.2.json](fixtures/md-bench-v0.2.json), and the ordered search space is in [fixtures/md-bench-v0.2-search-space.json](fixtures/md-bench-v0.2-search-space.json).

## External prior-art references

The following work informed the benchmark boundary and is not a runtime dependency:

- [Presidio](https://github.com/data-privacy-stack/presidio): configurable detection and anonymization operations.
- [pii-proxy](https://github.com/daslabhq/pii-proxy): stable substitution and round-trip restoration.
- [og-local](https://github.com/outgate-ai/og-local): opaque placeholder substitution and response restoration.
- [Operationalizing Data Minimization](https://github.com/PEACH-Research-Lab/Operationalize-Data-Minimization): privacy transformations searched under a downstream utility constraint.
- [STAMP](https://aclanthology.org/2026.eacl-long.61/): separate task relevance and privacy sensitivity in input protection.
- [AgentDAM](https://proceedings.neurips.cc/paper_files/paper/2025/hash/c9826b9ea5e1b49b256329934a578d83-Abstract-Datasets_and_Benchmarks_Track.html): purpose-specific necessity in end-to-end agent evaluation.
- [Privacy-R1](https://aclanthology.org/2026.acl-long.2130/): adaptive handling of replaceable and task-critical PII.
