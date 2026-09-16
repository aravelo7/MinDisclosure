'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const REPRESENTATIONS = [
  'RAW_VALUE',
  'COARSENED_VALUE',
  'DERIVED_PROPERTY',
  'RELATION_ONLY',
  'OPAQUE_TOKEN',
  'REDACTED'
];

const STRATEGIES = [
  'FIXED_REDACTION',
  'STABLE_TOKENIZATION',
  'TASK_AWARE'
];

const TASK_IDS = [
  'MD-EQ-01',
  'MD-GROUP-02',
  'MD-ORDER-03',
  'MD-LOC-04',
  'MD-CROSS-05',
  'MD-GRAPH-06',
  'MD-TOOL-07'
];

const DEFAULT_FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'md-bench-v0.1.json'
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return isDeepStrictEqual(actual, expected);
}

function pathParts(sourcePath) {
  const parts = [];
  const body = sourcePath.replace(/^\$\.?/, '');
  const matcher = /([^.[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = matcher.exec(body)) !== null) {
    parts.push(match[1] === undefined ? Number(match[2]) : match[1]);
  }
  return parts;
}

function getAtPath(root, sourcePath) {
  return pathParts(sourcePath).reduce((value, part) => value[part], root);
}

function setAtPath(root, sourcePath, replacement) {
  const parts = pathParts(sourcePath);
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value[part], root);
  parent[key] = replacement;
}

function emptyCategoryCounts() {
  return Object.fromEntries(REPRESENTATIONS.map((name) => [name, 0]));
}

function loadFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  validateFixture(fixture);
  return fixture;
}

function validateFixture(fixture) {
  if (fixture.benchmark_version !== 'md-bench-v0.1') {
    throw new Error('unexpected benchmark version');
  }
  if (!isDeepStrictEqual(fixture.strategies, STRATEGIES)) {
    throw new Error('strategy order differs from frozen contract');
  }
  if (!isDeepStrictEqual(fixture.tasks.map((task) => task.task_id), TASK_IDS)) {
    throw new Error('task set or task order differs from frozen contract');
  }
  for (const representation of REPRESENTATIONS) {
    if (typeof fixture.exposure_weights[representation] !== 'number') {
      throw new Error(`missing exposure weight for ${representation}`);
    }
  }
  for (const task of fixture.tasks) {
    const occurrenceIds = task.sensitive_entities.map((item) => item.occurrence_id);
    if (new Set(occurrenceIds).size !== occurrenceIds.length) {
      throw new Error(`${task.task_id}: duplicate occurrence id`);
    }
    const actionOccurrenceIds = task.task_aware_actions
      .filter((action) => action.representation !== 'RELATION_ONLY')
      .flatMap((action) => action.source_occurrence_ids);
    if (!isDeepStrictEqual(actionOccurrenceIds.sort(), [...occurrenceIds].sort())) {
      throw new Error(`${task.task_id}: Task-aware occurrence plan is incomplete`);
    }
    for (const entity of task.sensitive_entities) {
      const source = getAtPath(task.raw_input, entity.source_path);
      if (typeof source === 'string' && !source.includes(entity.raw_value)) {
        throw new Error(`${task.task_id}: raw value missing at ${entity.source_path}`);
      }
    }
  }
}

function ledgerEntry(fixture, task, strategy, boundary, action) {
  return {
    task_id: task.task_id,
    strategy,
    boundary,
    source_occurrence_ids: [...action.source_occurrence_ids],
    representation: action.representation,
    disclosed_name: action.disclosed_name,
    disclosed_value: clone(action.disclosed_value),
    requirement_id: action.requirement_id ?? null,
    exposure_weight: fixture.exposure_weights[action.representation]
  };
}

function transformTask(fixture, task, strategy) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`unknown strategy: ${strategy}`);
  }

  const agentInput = clone(task.raw_input);
  const agentLedger = [];
  const tokenToRaw = new Map();
  const tokenToOccurrences = new Map();
  const identityToToken = new Map();
  const replacementByOccurrence = new Map();
  const taskAwareByOccurrence = new Map();
  const disclosedRelations = [];
  let tokenCounter = 0;

  if (strategy === 'TASK_AWARE') {
    for (const action of task.task_aware_actions) {
      if (action.representation === 'RELATION_ONLY') {
        const entry = ledgerEntry(fixture, task, strategy, 'AGENT', action);
        agentLedger.push(entry);
        disclosedRelations.push({
          name: action.disclosed_name,
          arguments: clone(action.disclosed_value.arguments),
          value: action.disclosed_value.value
        });
      } else {
        if (action.source_occurrence_ids.length !== 1) {
          throw new Error(`${task.task_id}: occurrence action must have one source`);
        }
        taskAwareByOccurrence.set(action.source_occurrence_ids[0], action);
      }
    }
  }

  function assignToken(entity) {
    const identity = entity.entity_identity ?? entity.raw_value;
    if (!identityToToken.has(identity)) {
      tokenCounter += 1;
      identityToToken.set(identity, `<E_${String(tokenCounter).padStart(3, '0')}>`);
    }
    const token = identityToToken.get(identity);
    tokenToRaw.set(token, entity.raw_value);
    const sources = tokenToOccurrences.get(token) ?? [];
    sources.push(entity.occurrence_id);
    tokenToOccurrences.set(token, sources);
    return token;
  }

  task.sensitive_entities.forEach((entity, index) => {
    let action;
    let replacement;

    if (strategy === 'FIXED_REDACTION') {
      replacement = `<REDACTED_${String(index + 1).padStart(3, '0')}>`;
      action = {
        source_occurrence_ids: [entity.occurrence_id],
        representation: 'REDACTED',
        disclosed_name: 'redacted',
        disclosed_value: replacement,
        requirement_id: null
      };
    } else if (strategy === 'STABLE_TOKENIZATION') {
      replacement = assignToken(entity);
      action = {
        source_occurrence_ids: [entity.occurrence_id],
        representation: 'OPAQUE_TOKEN',
        disclosed_name: 'identity_handle',
        disclosed_value: replacement,
        requirement_id: null
      };
    } else {
      const planned = taskAwareByOccurrence.get(entity.occurrence_id);
      if (!planned) {
        throw new Error(`${task.task_id}: no Task-aware action for ${entity.occurrence_id}`);
      }
      action = clone(planned);
      switch (action.representation) {
        case 'REDACTED':
          replacement = `<REDACTED_${String(index + 1).padStart(3, '0')}>`;
          action.disclosed_value = replacement;
          break;
        case 'OPAQUE_TOKEN':
          replacement = assignToken(entity);
          action.disclosed_value = replacement;
          break;
        case 'DERIVED_PROPERTY':
        case 'COARSENED_VALUE':
          replacement = {[action.disclosed_name]: clone(action.disclosed_value)};
          break;
        case 'RAW_VALUE':
          replacement = entity.raw_value;
          action.disclosed_value = entity.raw_value;
          break;
        default:
          throw new Error(`${task.task_id}: unsupported occurrence representation`);
      }
    }

    replacementByOccurrence.set(entity.occurrence_id, replacement);
    agentLedger.push(ledgerEntry(fixture, task, strategy, 'AGENT', action));
  });

  const entitiesByPath = new Map();
  for (const entity of task.sensitive_entities) {
    const list = entitiesByPath.get(entity.source_path) ?? [];
    list.push(entity);
    entitiesByPath.set(entity.source_path, list);
  }

  for (const [sourcePath, entities] of entitiesByPath.entries()) {
    if (entities.length === 1) {
      setAtPath(agentInput, sourcePath, replacementByOccurrence.get(entities[0].occurrence_id));
      continue;
    }
    let text = getAtPath(agentInput, sourcePath);
    for (const entity of entities) {
      const replacement = replacementByOccurrence.get(entity.occurrence_id);
      text = text.replace(entity.raw_value, replacement);
    }
    setAtPath(agentInput, sourcePath, text);
  }

  if (disclosedRelations.length > 0) {
    agentInput.disclosed_relations = disclosedRelations;
  }

  return {
    task_id: task.task_id,
    strategy,
    agent_input: agentInput,
    agent_ledger: agentLedger,
    token_to_raw: tokenToRaw,
    token_to_occurrences: tokenToOccurrences
  };
}

function relationList(agentInput, name) {
  return (agentInput.disclosed_relations ?? []).filter((item) => item.name === name);
}

function executeEq(agentInput) {
  const relations = relationList(agentInput, 'same_email_identity');
  if (relations.length > 0) {
    return {duplicate_groups: relations.map((relation) => relation.arguments)};
  }
  const groups = new Map();
  for (const record of agentInput.records) {
    const ids = groups.get(record.email) ?? [];
    ids.push(record.record_id);
    groups.set(record.email, ids);
  }
  return {duplicate_groups: [...groups.values()].filter((ids) => ids.length > 1)};
}

function executeGroup(agentInput) {
  const invoices = agentInput.invoices;
  const parent = new Map(invoices.map((invoice) => [invoice.invoice_id, invoice.invoice_id]));

  function find(id) {
    const p = parent.get(id);
    if (p !== id) {
      parent.set(id, find(p));
    }
    return parent.get(id);
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  }

  for (const relation of relationList(agentInput, 'same_email_domain')) {
    union(relation.arguments[0], relation.arguments[1]);
  }

  const grouped = new Map();
  for (const invoice of invoices) {
    const root = find(invoice.invoice_id);
    const group = grouped.get(root) ?? {invoice_ids: [], total_amount: 0};
    group.invoice_ids.push(invoice.invoice_id);
    group.total_amount += invoice.amount;
    grouped.set(root, group);
  }
  return {
    groups: [...grouped.values()].map((group, index) => ({
      group_id: `g${index + 1}`,
      invoice_ids: group.invoice_ids,
      total_amount: group.total_amount
    }))
  };
}

function executeOrder(agentInput) {
  const people = [...agentInput.people];
  if (people.every((person) => person.date_of_birth && typeof person.date_of_birth === 'object' && Number.isInteger(person.date_of_birth.oldest_rank))) {
    people.sort((left, right) => left.date_of_birth.oldest_rank - right.date_of_birth.oldest_rank);
  }
  return {ordered_record_ids: people.map((person) => person.record_id)};
}

function executeLocation(agentInput) {
  const zoneCounts = Object.keys(agentInput.zone_rule).map((zone) => ({zone, count: 0}));
  const byZone = new Map(zoneCounts.map((item) => [item.zone, item]));
  for (const request of agentInput.requests) {
    if (request.address && typeof request.address === 'object') {
      const item = byZone.get(request.address.service_zone);
      if (item) {
        item.count += 1;
      }
    }
  }
  return {zone_counts: zoneCounts};
}

function executeCross(agentInput) {
  return {
    event_pairs: relationList(agentInput, 'same_subject_within_72_hours')
      .map((relation) => relation.arguments)
  };
}

function graphFromRelations(agentInput) {
  const relations = relationList(agentInput, 'referred_to_clinician');
  const nodes = [];
  const seen = new Set();
  const edges = relations.map((relation) => {
    for (const node of relation.arguments) {
      if (!seen.has(node)) {
        seen.add(node);
        nodes.push(node);
      }
    }
    return {from: relation.arguments[0], to: relation.arguments[1]};
  });
  return {nodes, edges};
}

function graphFromNotes(agentInput) {
  const parsedEdges = [];
  for (const note of agentInput.notes) {
    const match = note.match(/^(?:Dr\.\s+)?(.+?) referred (.+?) to clinician (.+?)\.$/);
    if (!match) {
      return {nodes: [], edges: []};
    }
    parsedEdges.push({from: match[1], to: match[3]});
  }

  const nodeByHandle = new Map();
  function nodeId(handle) {
    if (!nodeByHandle.has(handle)) {
      nodeByHandle.set(handle, `n${nodeByHandle.size + 1}`);
    }
    return nodeByHandle.get(handle);
  }

  const edges = parsedEdges.map((edge) => ({
    from: nodeId(edge.from),
    to: nodeId(edge.to)
  }));
  return {nodes: [...nodeByHandle.values()], edges};
}

function executeGraph(agentInput) {
  return relationList(agentInput, 'referred_to_clinician').length > 0
    ? graphFromRelations(agentInput)
    : graphFromNotes(agentInput);
}

function executeTool(agentInput) {
  const selected = agentInput.tickets.reduce((best, ticket) => (
    ticket.severity > best.severity ? ticket : best
  ));
  const serviceZone = selected.address && typeof selected.address === 'object'
    ? selected.address.service_zone
    : Object.keys(agentInput.zone_rule)[0];
  return {
    tool: 'dispatch_visit',
    arguments: {
      ticket_id: selected.ticket_id,
      recipient: selected.recipient_email,
      service_zone: serviceZone
    }
  };
}

function executeTask(task, transformed) {
  const agentInput = transformed.agent_input;
  switch (task.task_id) {
    case 'MD-EQ-01': return executeEq(agentInput);
    case 'MD-GROUP-02': return executeGroup(agentInput);
    case 'MD-ORDER-03': return executeOrder(agentInput);
    case 'MD-LOC-04': return executeLocation(agentInput);
    case 'MD-CROSS-05': return executeCross(agentInput);
    case 'MD-GRAPH-06': return executeGraph(agentInput);
    case 'MD-TOOL-07': return executeTool(agentInput);
    default: throw new Error(`no deterministic executor for ${task.task_id}`);
  }
}

function parseCandidate(rawOutput) {
  if (typeof rawOutput === 'string') {
    try {
      return {parsed: JSON.parse(rawOutput), error: null};
    } catch (error) {
      return {parsed: null, error: error.message};
    }
  }
  if (rawOutput && typeof rawOutput === 'object') {
    return {parsed: clone(rawOutput), error: null};
  }
  return {parsed: null, error: 'output must be a JSON object or JSON string'};
}

function stringsOnly(values) {
  return Array.isArray(values) && values.every((value) => typeof value === 'string');
}

function validateOutputSchema(taskId, value) {
  switch (taskId) {
    case 'MD-EQ-01':
      return exactKeys(value, ['duplicate_groups']) &&
        Array.isArray(value.duplicate_groups) &&
        value.duplicate_groups.every(stringsOnly);
    case 'MD-GROUP-02':
      return exactKeys(value, ['groups']) && Array.isArray(value.groups) &&
        value.groups.every((group) => exactKeys(group, ['group_id', 'invoice_ids', 'total_amount']) &&
          typeof group.group_id === 'string' && stringsOnly(group.invoice_ids) &&
          typeof group.total_amount === 'number');
    case 'MD-ORDER-03':
      return exactKeys(value, ['ordered_record_ids']) && stringsOnly(value.ordered_record_ids);
    case 'MD-LOC-04':
      return exactKeys(value, ['zone_counts']) && Array.isArray(value.zone_counts) &&
        value.zone_counts.every((item) => exactKeys(item, ['zone', 'count']) &&
          typeof item.zone === 'string' && Number.isInteger(item.count));
    case 'MD-CROSS-05':
      return exactKeys(value, ['event_pairs']) && Array.isArray(value.event_pairs) &&
        value.event_pairs.every((pair) => stringsOnly(pair) && pair.length === 2);
    case 'MD-GRAPH-06':
      return exactKeys(value, ['nodes', 'edges']) && stringsOnly(value.nodes) &&
        Array.isArray(value.edges) && value.edges.every((edge) =>
          exactKeys(edge, ['from', 'to']) && typeof edge.from === 'string' && typeof edge.to === 'string');
    case 'MD-TOOL-07':
      return exactKeys(value, ['tool', 'arguments']) && value.tool === 'dispatch_visit' &&
        exactKeys(value.arguments, ['ticket_id', 'recipient', 'service_zone']) &&
        typeof value.arguments.ticket_id === 'string' &&
        typeof value.arguments.recipient === 'string' &&
        ['NORTH', 'EAST'].includes(value.arguments.service_zone);
    default:
      return false;
  }
}

function notApplicableRestore() {
  return {
    applicable: false,
    restored_items: 0,
    correctly_restored_items: 0,
    exact_match_rate: null,
    unknown_token_count: 0,
    accidental_raw_output_count: 0
  };
}

function restoreToolOutput(fixture, task, parsed, transformed) {
  const result = {
    restored_output: clone(parsed),
    restore_correctness: notApplicableRestore(),
    tool_ledger: []
  };
  const reversible = transformed.strategy !== 'FIXED_REDACTION' &&
    transformed.token_to_raw.size > 0;
  if (!reversible) {
    return result;
  }

  const metrics = {
    applicable: true,
    restored_items: 0,
    correctly_restored_items: 0,
    exact_match_rate: null,
    unknown_token_count: 0,
    accidental_raw_output_count: 0
  };
  const recipient = parsed.arguments.recipient;
  const allRawValues = new Set(task.sensitive_entities.map((item) => item.raw_value));

  if (transformed.token_to_raw.has(recipient)) {
    const rawValue = transformed.token_to_raw.get(recipient);
    result.restored_output.arguments.recipient = rawValue;
    metrics.restored_items = 1;
    metrics.correctly_restored_items = 1;
    metrics.exact_match_rate = 1;
    const requirementId = transformed.strategy === 'TASK_AWARE'
      ? 'req_tool_exact_recipient'
      : null;
    result.tool_ledger.push(ledgerEntry(fixture, task, transformed.strategy, 'TOOL', {
      source_occurrence_ids: transformed.token_to_occurrences.get(recipient) ?? [],
      representation: 'RAW_VALUE',
      disclosed_name: 'recipient',
      disclosed_value: rawValue,
      requirement_id: requirementId
    }));
  } else if (/^<E_\d+>$/.test(recipient)) {
    metrics.unknown_token_count = 1;
  } else if (allRawValues.has(recipient)) {
    metrics.accidental_raw_output_count = 1;
  }

  result.restore_correctness = metrics;
  return result;
}

function normalizePartition(groups) {
  return groups
    .map((group) => [...group.invoice_ids].sort())
    .sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

function identityPreservedForCross(transformed) {
  if (transformed.strategy === 'TASK_AWARE') {
    return transformed.agent_ledger.some((entry) =>
      entry.representation === 'RELATION_ONLY' &&
      entry.disclosed_name === 'same_subject_within_72_hours');
  }
  if (transformed.strategy !== 'STABLE_TOKENIZATION') {
    return false;
  }
  const emailEntries = transformed.agent_ledger.filter((entry) =>
    entry.source_occurrence_ids.some((id) => id.startsWith('cross_email_')));
  const e1 = emailEntries.find((entry) => entry.source_occurrence_ids.includes('cross_email_e1'));
  const e3 = emailEntries.find((entry) => entry.source_occurrence_ids.includes('cross_email_e3'));
  const e2 = emailEntries.find((entry) => entry.source_occurrence_ids.includes('cross_email_e2'));
  return Boolean(e1 && e3 && e2 && e1.disclosed_value === e3.disclosed_value && e1.disclosed_value !== e2.disclosed_value);
}

function relationshipChecks(task, parsed, restoredOutput, schemaValid, transformed, restoreCorrectness) {
  const falseChecks = Object.fromEntries(task.oracle.relationship_checks.map((name) => [name, false]));
  if (!schemaValid) {
    return falseChecks;
  }
  switch (task.task_id) {
    case 'MD-EQ-01':
      return {equality_preserved: isDeepStrictEqual(parsed.duplicate_groups, task.ground_truth.duplicate_groups)};
    case 'MD-GROUP-02':
      return {
        grouping_preserved: isDeepStrictEqual(normalizePartition(parsed.groups), normalizePartition(task.ground_truth.groups)),
        aggregate_values_correct: isDeepStrictEqual(
          parsed.groups.map((group) => [group.group_id, group.total_amount]),
          task.ground_truth.groups.map((group) => [group.group_id, group.total_amount])
        )
      };
    case 'MD-ORDER-03':
      return {ordering_preserved: isDeepStrictEqual(parsed.ordered_record_ids, task.ground_truth.ordered_record_ids)};
    case 'MD-LOC-04':
      return {coarse_location_preserved: isDeepStrictEqual(parsed.zone_counts, task.ground_truth.zone_counts)};
    case 'MD-CROSS-05':
      return {
        identity_preserved: identityPreservedForCross(transformed),
        window_relation_preserved: isDeepStrictEqual(parsed.event_pairs, task.ground_truth.event_pairs)
      };
    case 'MD-GRAPH-06':
      return {relation_edges_preserved: isDeepStrictEqual(parsed.edges, task.ground_truth.edges)};
    case 'MD-TOOL-07':
      return {
        selection_preserved: parsed.arguments.ticket_id === task.ground_truth.arguments.ticket_id,
        tool_argument_property_preserved: parsed.arguments.service_zone === task.ground_truth.arguments.service_zone,
        exact_recipient_after_restore: restoreCorrectness.accidental_raw_output_count === 0 &&
          restoredOutput.arguments.recipient === task.ground_truth.arguments.recipient
      };
    default:
      return falseChecks;
  }
}

function evaluateOutput(fixture, task, rawOutput, transformed) {
  const {parsed, error} = parseCandidate(rawOutput);
  if (error || !validateOutputSchema(task.task_id, parsed)) {
    return {
      task_success: false,
      validity: 'schema_invalid',
      parse_error: error,
      restored_output: null,
      relationship_checks: relationshipChecks(task, null, null, false, transformed, notApplicableRestore()),
      restore_correctness: notApplicableRestore(),
      tool_ledger: []
    };
  }

  let restoredOutput = parsed;
  let restoreCorrectness = notApplicableRestore();
  let toolLedger = [];
  if (task.task_id === 'MD-TOOL-07') {
    const restored = restoreToolOutput(fixture, task, parsed, transformed);
    restoredOutput = restored.restored_output;
    restoreCorrectness = restored.restore_correctness;
    toolLedger = restored.tool_ledger;
  }

  const relationship = relationshipChecks(
    task,
    parsed,
    restoredOutput,
    true,
    transformed,
    restoreCorrectness
  );
  const rawViolation = restoreCorrectness.accidental_raw_output_count > 0;
  return {
    task_success: !rawViolation && isDeepStrictEqual(restoredOutput, task.ground_truth),
    validity: 'valid',
    parse_error: null,
    restored_output: restoredOutput,
    relationship_checks: relationship,
    restore_correctness: restoreCorrectness,
    tool_ledger: toolLedger
  };
}

function summarizeBoundary(ledger, boundary) {
  const items = ledger.filter((entry) => entry.boundary === boundary);
  const categoryCounts = emptyCategoryCounts();
  for (const item of items) {
    categoryCounts[item.representation] += 1;
  }
  const rawItems = items.filter((entry) => entry.representation === 'RAW_VALUE');
  return {
    category_counts: categoryCounts,
    raw_exposure_count: rawItems.length,
    raw_distinct_count: new Set(rawItems.map((entry) => JSON.stringify(entry.disclosed_value))).size,
    exposure_score: items.reduce((total, entry) => total + entry.exposure_weight, 0)
  };
}

function runTaskStrategy(fixture, task, strategy) {
  const transformed = transformTask(fixture, task, strategy);
  const candidateOutput = executeTask(task, transformed);
  const evaluated = evaluateOutput(fixture, task, candidateOutput, transformed);
  const ledger = [...transformed.agent_ledger, ...evaluated.tool_ledger];
  return {
    task_id: task.task_id,
    strategy,
    task_success: evaluated.task_success,
    validity: evaluated.validity,
    relationship_checks: evaluated.relationship_checks,
    restore_correctness: evaluated.restore_correctness,
    exposure: {
      agent: summarizeBoundary(ledger, 'AGENT'),
      tool: summarizeBoundary(ledger, 'TOOL'),
      ledger
    },
    agent_input: transformed.agent_input,
    candidate_output: candidateOutput,
    restored_output: evaluated.restored_output
  };
}

function runBenchmark(fixture = loadFixture()) {
  const results = [];
  for (const task of fixture.tasks) {
    for (const strategy of STRATEGIES) {
      results.push(runTaskStrategy(fixture, task, strategy));
    }
  }
  const strategy_summary = Object.fromEntries(STRATEGIES.map((strategy) => {
    const selected = results.filter((result) => result.strategy === strategy);
    return [strategy, {
      successful_tasks: selected.filter((result) => result.task_success).length,
      total_tasks: selected.length,
      agent_exposure_score: selected.reduce((sum, result) => sum + result.exposure.agent.exposure_score, 0),
      tool_exposure_score: selected.reduce((sum, result) => sum + result.exposure.tool.exposure_score, 0)
    }];
  }));
  return {
    benchmark_version: fixture.benchmark_version,
    execution_kind: 'deterministic_no_llm',
    total_combinations: results.length,
    strategy_summary,
    results
  };
}

function parseCli(argv) {
  if (argv.length === 0) {
    return {outputPath: null};
  }
  if (argv.length === 2 && argv[0] === '--output') {
    return {outputPath: path.resolve(argv[1])};
  }
  throw new Error('usage: node src/benchmark.js [--output <result.json>]');
}

if (require.main === module) {
  const {outputPath} = parseCli(process.argv.slice(2));
  const result = runBenchmark();
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    fs.writeFileSync(outputPath, json, 'utf8');
    process.stdout.write(`${JSON.stringify({output: outputPath, total_combinations: result.total_combinations})}\n`);
  } else {
    process.stdout.write(json);
  }
}

module.exports = {
  DEFAULT_FIXTURE_PATH,
  REPRESENTATIONS,
  STRATEGIES,
  TASK_IDS,
  evaluateOutput,
  executeTask,
  loadFixture,
  runBenchmark,
  runTaskStrategy,
  summarizeBoundary,
  transformTask,
  validateOutputSchema
};
