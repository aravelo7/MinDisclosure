# Task Cases — `md-bench-v0.2`

Status: **FROZEN**. The normative machine-readable form, including occurrence annotations and ledger expectations, is `fixtures/md-bench-v0.2.json`. All solvers receive the same instruction and closed output schema across strategies.

## `MD-EQ-01` — Duplicate contact detection

Input emails by record are `r1=alice@northwind.example`, `r2=bob@contoso.example`, `r3=alice@northwind.example`, and `r4=carol@northwind.example`.

Task: return non-singleton duplicate-email groups in input order.

Ground truth:

```json
{"duplicate_groups":[["r1","r3"]]}
```

Oracle representation: the same task-local stable tokens used by Stable Tokenization. It does not emit an equality edge or duplicate group. The solver must deduplicate. This is an identity-only strong control.

## `MD-GROUP-02` — Group and aggregate by email domain

Invoices are:

```json
[
  {"invoice_id":"i1","contact_email":"ana@northwind.example","amount":20},
  {"invoice_id":"i2","contact_email":"ben@northwind.example","amount":35},
  {"invoice_id":"i3","contact_email":"cy@contoso.example","amount":40},
  {"invoice_id":"i4","contact_email":"dee@northwind.example","amount":5}
]
```

Task: group by domain in first-appearance order and compute members and sums.

Ground truth:

```json
{"groups":[{"group_id":"g1","invoice_ids":["i1","i2","i4"],"total_amount":60},{"group_id":"g2","invoice_ids":["i3"],"total_amount":40}]}
```

Oracle representation: each email is independently converted to a neutral `domain_handle`. No pairwise same-domain relation, group, or aggregate is emitted. The solver performs grouping and summation.

## `MD-ORDER-03` — Order by coarsened date of birth

People are `p1=1994-06-12`, `p2=1981-11-03`, `p3=2000-01-25`, and `p4=1988-09-17`.

Task: sort record IDs from oldest to youngest.

Ground truth:

```json
{"ordered_record_ids":["p2","p4","p1","p3"]}
```

Oracle representation: field-local birth years `1994, 1981, 2000, 1988`. Years are unique in this synthetic fixture, so they are sufficient without rank. The solver performs sorting.

## `MD-LOC-04` — Zone grouping and aggregation

Requests retain non-sensitive amounts `15, 20, 30, 5`. Their raw addresses are the Beijing, Shanghai, Hangzhou, and Beijing addresses from v0.1. The source `zone_rule` maps Beijing to `NORTH` and Shanghai/Hangzhou to `EAST`.

Task: return count and total amount per zone in `zone_rule` order.

Ground truth:

```json
{"zone_summaries":[{"zone":"NORTH","count":2,"total_amount":20},{"zone":"EAST","count":2,"total_amount":50}]}
```

Oracle representation: each address is independently coarsened to its service zone. The solver must still group, count, and sum; copying the zone alone is not a solution.

## `MD-CROSS-05` — Same subject inside a time window

Events remain:

```json
[
  {"event_id":"e1","subject_email":"lee@sample.example","timestamp":"2026-04-01T09:00:00Z"},
  {"event_id":"e2","subject_email":"kim@sample.example","timestamp":"2026-04-01T12:00:00Z"},
  {"event_id":"e3","subject_email":"lee@sample.example","timestamp":"2026-04-03T08:00:00Z"},
  {"event_id":"e4","subject_email":"lee@sample.example","timestamp":"2026-04-10T09:00:00Z"},
  {"event_id":"e5","subject_email":"kim@sample.example","timestamp":"2026-04-05T13:00:00Z"}
]
```

Task: return same-subject pairs no more than 72 hours apart.

Ground truth:

```json
{"event_pairs":[["e1","e3"]]}
```

Oracle representation: task-local subject tokens plus field-local timestamps coarsened to hour precision. It emits no matching pair or `within_72h` relation. The solver performs identity matching and time subtraction; `e2/e5` remains excluded at 97 hours.

## `MD-GRAPH-06` — Computation over source graph edges

Raw source edges are:

```json
[
  {"edge_id":"g1","from":"Mira Chen","to":"Luis Gomez"},
  {"edge_id":"g2","from":"Luis Gomez","to":"Sara Ito"},
  {"edge_id":"g3","from":"Sara Ito","to":"Mira Chen"}
]
```

Task: assign anonymous node IDs by first endpoint appearance, compute each node's out-degree, and return nodes reachable from `n1` in exactly two hops.

Ground truth:

```json
{"out_degree":[{"node":"n1","degree":1},{"node":"n2","degree":1},{"node":"n3","degree":1}],"reachable_from_n1_in_two_hops":["n3"]}
```

Oracle and Stable representations both tokenize node identities and preserve only the three directed edges already explicit in source input. Neither emits degree or reachability. This is the second Stable strong control.

## `MD-TOOL-07` — Select, then restore one tool argument

All three tickets remain visible as candidates:

```json
[
  {"ticket_id":"t1","severity":2,"recipient_email":"mei.lin@example.com","address":"18 Harbor St, Haidian, Beijing 100080"},
  {"ticket_id":"t2","severity":5,"recipient_email":"omar.khan@example.com","address":"7 Lake Rd, Pudong, Shanghai 200120"},
  {"ticket_id":"t3","severity":3,"recipient_email":"ines.rossi@example.com","address":"99 Pine Ave, Xihu, Hangzhou 310013"}
]
```

Task: select the highest-severity ticket and produce one `dispatch_visit` call with ticket ID, recipient, and service zone.

Ground truth after trusted restoration:

```json
{"tool":"dispatch_visit","arguments":{"ticket_id":"t2","recipient":"omar.khan@example.com","service_zone":"EAST"}}
```

Oracle representation: all three emails become reversible tokens and all three addresses become service zones. The transformer does not preselect `t2`. The solver chooses from all candidates and outputs the chosen recipient token. Trusted restoration replaces only that final recipient at the Tool boundary.

## Deterministic oracle summary

| Task | Exact oracle | Solver computation that must remain |
|---|---|---|
| `MD-EQ-01` | Exact duplicate groups | Equality grouping |
| `MD-GROUP-02` | Exact ordered groups and sums | Grouping and aggregation |
| `MD-ORDER-03` | Exact ordered list | Sorting |
| `MD-LOC-04` | Exact ordered counts and sums | Grouping and aggregation |
| `MD-CROSS-05` | Exact ordered pair list | Identity matching and time comparison |
| `MD-GRAPH-06` | Exact degree list and two-hop result | Graph computation |
| `MD-TOOL-07` | Exact restored tool call | Argmax selection and argument construction |
