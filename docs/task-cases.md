# Frozen Task Cases — `md-bench-v0.1`

All JSON objects below are normative fixtures. Record order is frozen. The Agent receives the same instruction and output schema for every strategy, plus that strategy's transformed form of `raw_input`. Keys in expected outputs are closed: extra keys fail.

## `MD-EQ-01` — Duplicate contact detection

**Raw input**

```json
{
  "records": [
    {"record_id": "r1", "email": "alice@northwind.example"},
    {"record_id": "r2", "email": "bob@contoso.example"},
    {"record_id": "r3", "email": "alice@northwind.example"},
    {"record_id": "r4", "email": "carol@northwind.example"}
  ]
}
```

**User task**: Return groups of record IDs that use the same email address. Omit singleton groups. Sort IDs inside each group by input order, and sort groups by their first record's input order.

**Expected output schema**

```json
{"duplicate_groups": [["record_id"]]}
```

**Ground truth**

```json
{"duplicate_groups": [["r1", "r3"]]}
```

**Oracle**: exact JSON equality after rejecting extra keys. `equality_preserved=true` iff the exact group is returned.

**Sensitive entities**: four `EMAIL` occurrences; `r1` and `r3` share identity `email_alice_northwind`; the others have distinct identities. Sensitive properties include local part and domain.

**Required**: equality relation between complete email identities. Exact value is not required at any boundary.

**Explicitly not required**: local parts, domains, domain class, email text, person identity outside this instance.

**Why discriminating**: Fixed Redaction uses unrelated occurrence placeholders and removes equality. Stable Tokenization should pass by repeating the same neutral token for `r1` and `r3`. Task-aware can pass with one `RELATION_ONLY` equality fact and need not expose a reusable entity token. This is a Stable-sufficiency control, not an expected utility win for Task-aware.

## `MD-GROUP-02` — Aggregate invoices by email domain

**Raw input**

```json
{
  "invoices": [
    {"invoice_id": "i1", "contact_email": "ana@northwind.example", "amount": 20},
    {"invoice_id": "i2", "contact_email": "ben@northwind.example", "amount": 35},
    {"invoice_id": "i3", "contact_email": "cy@contoso.example", "amount": 40},
    {"invoice_id": "i4", "contact_email": "dee@northwind.example", "amount": 5}
  ]
}
```

**User task**: Group invoices whose contact emails have the same domain. Name groups `g1`, `g2`, ... by the first appearance of each domain. Return member invoice IDs in input order and the sum of `amount` for each group.

**Expected output schema**

```json
{"groups": [{"group_id": "string", "invoice_ids": ["invoice_id"], "total_amount": 0}]}
```

**Ground truth**

```json
{
  "groups": [
    {"group_id": "g1", "invoice_ids": ["i1", "i2", "i4"], "total_amount": 60},
    {"group_id": "g2", "invoice_ids": ["i3"], "total_amount": 40}
  ]
}
```

**Oracle**: exact ordered JSON equality. `grouping_preserved` checks the member partition; `aggregate_values_correct` checks both sums.

**Sensitive entities**: four distinct `EMAIL` identities. Their domain properties are `northwind.example`, `northwind.example`, `contoso.example`, and `northwind.example`.

**Required**: the equivalence relation `same_email_domain` across occurrences. Exact domain strings and exact emails are not required.

**Explicitly not required**: local parts, exact email, raw domain labels, person identity, cross-instance linkage.

**Why discriminating**: Fixed Redaction cannot form groups. Stable Tokenization preserves full-email equality only, but all four complete emails differ, so it cannot recover same-domain grouping. Task-aware may expose only same-domain relation tuples, avoiding raw or coarsened domain text.

## `MD-ORDER-03` — Order by date of birth without revealing dates

**Raw input**

```json
{
  "people": [
    {"record_id": "p1", "date_of_birth": "1994-06-12"},
    {"record_id": "p2", "date_of_birth": "1981-11-03"},
    {"record_id": "p3", "date_of_birth": "2000-01-25"},
    {"record_id": "p4", "date_of_birth": "1988-09-17"}
  ]
}
```

**User task**: Return record IDs from oldest person to youngest person.

**Expected output schema**

```json
{"ordered_record_ids": ["record_id"]}
```

**Ground truth**

```json
{"ordered_record_ids": ["p2", "p4", "p1", "p3"]}
```

**Oracle**: exact list equality. `ordering_preserved=true` iff all four IDs appear exactly once in the frozen order.

**Sensitive entities**: four `DATE_OF_BIRTH` occurrences and identities. Derived `oldest_rank` values are frozen as `p2=1`, `p4=2`, `p1=3`, `p3=4`.

**Required**: total order by date of birth, or equivalently the frozen rank for each record. Exact dates and exact ages are not required.

**Explicitly not required**: date strings, birth month/day, exact age, age bucket.

**Why discriminating**: Fixed Redaction and neutral Stable tokens remove order. Task-aware can expose `DERIVED_PROPERTY oldest_rank` or an equivalent complete set of `RELATION_ONLY before` facts without exposing dates.

## `MD-LOC-04` — Coarse service-zone routing

**Raw input**

```json
{
  "requests": [
    {"request_id": "q1", "address": "18 Harbor St, Haidian, Beijing 100080"},
    {"request_id": "q2", "address": "7 Lake Rd, Pudong, Shanghai 200120"},
    {"request_id": "q3", "address": "99 Pine Ave, Xihu, Hangzhou 310013"},
    {"request_id": "q4", "address": "4 North Rd, Chaoyang, Beijing 100020"}
  ],
  "zone_rule": {
    "NORTH": ["Beijing"],
    "EAST": ["Shanghai", "Hangzhou"]
  }
}
```

**User task**: Count requests in each service zone defined by `zone_rule`. Return zones in the order shown by `zone_rule`.

**Expected output schema**

```json
{"zone_counts": [{"zone": "string", "count": 0}]}
```

**Ground truth**

```json
{"zone_counts": [{"zone": "NORTH", "count": 2}, {"zone": "EAST", "count": 2}]}
```

**Oracle**: exact ordered JSON equality. `coarse_location_preserved=true` iff both zone labels and counts match.

**Sensitive entities**: four `POSTAL_ADDRESS` occurrences. Sensitive properties include street, district, city, postal code, and derived `service_zone` (`NORTH`, `EAST`, `EAST`, `NORTH`).

**Required**: the coarse `service_zone` property for each request. Exact address, city, district, and postal code are not required.

**Explicitly not required**: street, building number, district, city label, postal code, exact coordinates.

**Why discriminating**: Fixed Redaction and Stable Tokenization cannot map neutral address handles to zones. Task-aware can disclose the coarsened zone value while withholding every raw address component.

## `MD-CROSS-05` — Same subject with events inside a time window

**Raw input**

```json
{
  "events": [
    {"event_id": "e1", "subject_email": "lee@sample.example", "timestamp": "2026-04-01T09:00:00Z"},
    {"event_id": "e2", "subject_email": "kim@sample.example", "timestamp": "2026-04-01T12:00:00Z"},
    {"event_id": "e3", "subject_email": "lee@sample.example", "timestamp": "2026-04-03T08:00:00Z"},
    {"event_id": "e4", "subject_email": "lee@sample.example", "timestamp": "2026-04-10T09:00:00Z"},
    {"event_id": "e5", "subject_email": "kim@sample.example", "timestamp": "2026-04-05T13:00:00Z"}
  ]
}
```

**User task**: Return unordered pairs of events for the same subject whose timestamps are at most 72 hours apart. Put the earlier event ID first. Sort pairs by the first event's input order, then the second's.

**Expected output schema**

```json
{"event_pairs": [["event_id", "event_id"]]}
```

**Ground truth**

```json
{"event_pairs": [["e1", "e3"]]}
```

**Oracle**: exact ordered JSON equality. `identity_preserved` checks same-subject filtering; `window_relation_preserved` checks the 72-hour relation and rejects `e2/e5` because they are 97 hours apart.

**Sensitive entities**: five `EMAIL` occurrences representing two identities; five `EVENT_TIMESTAMP` occurrences. Timestamp properties include order and pairwise elapsed duration.

**Required**: email identity equality and the cross-record relation `within_72_hours` for same-subject candidates. Exact email and timestamp values are not required.

**Explicitly not required**: email text/domain, timestamp text, calendar date, hour, exact elapsed duration beyond the boolean threshold.

**Why discriminating**: Stable Tokenization correctly preserves the two subject identities but hides timestamp comparison, so identity alone is insufficient. Task-aware must combine opaque subject identity with only the required time-window relation. Fixed Redaction preserves neither.

## `MD-GRAPH-06` — Referral relation graph

**Raw input**

```json
{
  "notes": [
    "Dr. Mira Chen referred Noah Park to clinician Luis Gomez.",
    "Luis Gomez referred Noah Park to clinician Sara Ito.",
    "Sara Ito referred Noah Park to clinician Mira Chen."
  ]
}
```

**User task**: Build the directed clinician referral graph. Ignore the patient. Assign clinician IDs `n1`, `n2`, ... by first appearance in the notes. Return each unique directed edge in note order.

**Expected output schema**

```json
{"nodes": ["node_id"], "edges": [{"from": "node_id", "to": "node_id"}]}
```

**Ground truth**

```json
{
  "nodes": ["n1", "n2", "n3"],
  "edges": [
    {"from": "n1", "to": "n2"},
    {"from": "n2", "to": "n3"},
    {"from": "n3", "to": "n1"}
  ]
}
```

**Oracle**: exact node list and exact ordered edge list. `relation_edges_preserved=true` only for the three-edge cycle with no extra edge.

**Sensitive entities**: clinician `PERSON_NAME` occurrences for Mira Chen (two occurrences, one identity), Luis Gomez (two, one identity), and Sara Ito (two, one identity); patient Noah Park occurs three times as one identity.

**Required**: clinician identity linkage, clinician role, and directed `referred_to_clinician` edges. Patient identity and value are not required.

**Explicitly not required**: any raw name, patient identity, name surface properties, demographics, organization, or location.

**Why discriminating**: A stable neutral token retains clinician identity across notes while grammatical roles retain the edge direction, so Stable should pass. Fixed Redaction uses fresh placeholders and therefore cannot link clinicians across notes to construct the cycle. Task-aware can provide only the anonymous relation graph. This is the second Stable-sufficiency control.

## `MD-TOOL-07` — Dispatch tool with property-dependent routing and exact restoration

**Raw input**

```json
{
  "tickets": [
    {
      "ticket_id": "t1",
      "severity": 2,
      "recipient_email": "mei.lin@example.com",
      "address": "18 Harbor St, Haidian, Beijing 100080"
    },
    {
      "ticket_id": "t2",
      "severity": 5,
      "recipient_email": "omar.khan@example.com",
      "address": "7 Lake Rd, Pudong, Shanghai 200120"
    },
    {
      "ticket_id": "t3",
      "severity": 3,
      "recipient_email": "ines.rossi@example.com",
      "address": "99 Pine Ave, Xihu, Hangzhou 310013"
    }
  ],
  "zone_rule": {
    "NORTH": ["Beijing"],
    "EAST": ["Shanghai", "Hangzhou"]
  }
}
```

**User task**: Select the ticket with the highest severity and issue exactly one `dispatch_visit` tool call with that ticket's ID, exact recipient email, and service zone from `zone_rule`.

**Expected output schema before trusted restoration**

```json
{
  "tool": "dispatch_visit",
  "arguments": {
    "ticket_id": "string",
    "recipient": "raw email or restorable token",
    "service_zone": "NORTH or EAST"
  }
}
```

**Ground truth after trusted restoration**

```json
{
  "tool": "dispatch_visit",
  "arguments": {
    "ticket_id": "t2",
    "recipient": "omar.khan@example.com",
    "service_zone": "EAST"
  }
}
```

**Oracle**: parse and schema-check the model output, restore only the declared `arguments.recipient` field, then require exact JSON equality with ground truth. `selection_preserved` checks `t2`; `tool_argument_property_preserved` checks `EAST`; `exact_recipient_after_restore` checks the raw email. Unknown tokens, raw email in an arm that declared tokenization, extra calls, or extra fields fail.

**Sensitive entities**: three `EMAIL` identities and three `POSTAL_ADDRESS` identities. Address properties include city and derived service zone.

**Required**: severity-based record selection (severity is non-sensitive), coarsened `service_zone` for the selected address at the Agent boundary, and exact selected email only at the post-restoration Tool boundary.

**Explicitly not required**: any raw address component; email local part/domain at the Agent boundary; unselected recipients or zones beyond what is needed to make the one call.

**Why discriminating**: Fixed Redaction cannot supply the recipient or zone. Stable Tokenization can select `t2` and can restore a copied recipient token, but cannot derive `EAST` from a neutral address token. Task-aware can disclose service zones while keeping recipient emails opaque until trusted restoration. This task distinguishes Agent exposure from necessary Tool-boundary disclosure.

## Frozen oracle summary

| Task | Oracle kind | Exact success condition |
|---|---|---|
| `MD-EQ-01` | exact JSON | One duplicate group: `r1,r3`. |
| `MD-GROUP-02` | exact JSON | Frozen two-group partition and totals `60,40`. |
| `MD-ORDER-03` | ordered list | `p2,p4,p1,p3`, each exactly once. |
| `MD-LOC-04` | exact JSON | `NORTH=2`, `EAST=2` in frozen order. |
| `MD-CROSS-05` | ordered pair set | Only `e1,e3`. |
| `MD-GRAPH-06` | exact graph | Nodes `n1,n2,n3` and the frozen three-edge cycle. |
| `MD-TOOL-07` | exact restored tool call | `dispatch_visit(t2, omar.khan@example.com, EAST)`. |
