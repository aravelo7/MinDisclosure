# MinDisclosure

Task- and Tool-Aware Minimum Disclosure for LLM Agents

**Status: Research Seed / Benchmark Specification**

## Problem

Conventional PII redaction removes information without asking which information a task actually needs. Stable tokenization preserves entity identity and equality, but it deliberately hides entity properties and non-equality relations. This project studies whether a task-aware disclosure policy can preserve only the properties or relations required for a task while exposing less sensitive information than raw input.

## Hypothesis

For tasks that require a sensitive property or relation beyond identity equality, Task-aware Minimum Disclosure can produce a measurable Privacy–Utility Pareto improvement over Fixed Redaction and, most importantly, Stable Tokenization. The hypothesis is weakened when Stable Tokenization reaches the same utility with equal or lower exposure on most tasks.

## Non-goals

- Building a production runtime, proxy, adapter, detector, or policy engine.
- Claiming that the benchmark exposure weights are a universal privacy metric.
- Evaluating PII detection quality in benchmark v0.1; sensitive entities and requirements are gold-annotated.
- Connecting to a real LLM API or installing external dependencies.
- Proving that task-aware disclosure is superior for every task.

## Benchmark methodology

`md-bench-v0.1` freezes the initial task set, disclosure representations, baselines, deterministic oracles, privacy-exposure accounting, and falsification criteria.

No runtime implementation or LLM evaluation results are included yet.

The seven frozen tasks include both expected Task-aware advantages and Stable Tokenization controls. Every strategy receives the same raw instance, user instruction, model configuration, output schema, and oracle. Utility, disclosure categories, weighted exposure, relation preservation, and reversible restoration are reported separately.

The frozen specification is in [docs/benchmark-spec.md](docs/benchmark-spec.md), and the complete task fixtures and oracles are in [docs/task-cases.md](docs/task-cases.md).

## External prior-art references

The following projects were consulted as prior art and are not benchmark dependencies:

- [Presidio](https://github.com/microsoft/presidio): detection plus configurable replace, redact, hash, mask, encrypt, and custom anonymization operations. Its documentation warns that automated detection is not guaranteed to find every sensitive item.
- [pii-proxy](https://github.com/daslabhq/pii-proxy): bijective plausible-value substitution, stable mapping, structured-object masking, and deterministic round-trip restoration; its documented failure modes include surface-property inference and broken cross-entity coherence.
- [og-local](https://github.com/outgate-ai/og-local): opaque placeholder substitution over prompt/tool fields, deterministic same-value placeholders within a session, and response restoration.
