'use strict';

const {isDeepStrictEqual} = require('node:util');
const {ledgerEntry} = require('./transformer');

const ORACLE_INPUT_KEYS = ['task_id', 'expected_output_schema', 'ground_truth', 'oracle', 'sensitive_entities'];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
function stringsOnly(values) { return Array.isArray(values) && values.every((value) => typeof value === 'string'); }
function projectOracleCase(task) {
  return Object.fromEntries(ORACLE_INPUT_KEYS.map((key) => [key, clone(task[key])]));
}

function validateOutputSchema(taskId, value) {
  switch (taskId) {
    case 'MD-EQ-01':
      return exactKeys(value, ['duplicate_groups']) && Array.isArray(value.duplicate_groups) && value.duplicate_groups.every(stringsOnly);
    case 'MD-GROUP-02':
      return exactKeys(value, ['groups']) && Array.isArray(value.groups) && value.groups.every((group) =>
        exactKeys(group, ['group_id', 'invoice_ids', 'total_amount']) && typeof group.group_id === 'string' &&
        stringsOnly(group.invoice_ids) && typeof group.total_amount === 'number');
    case 'MD-ORDER-03':
      return exactKeys(value, ['ordered_record_ids']) && stringsOnly(value.ordered_record_ids);
    case 'MD-LOC-04':
      return exactKeys(value, ['zone_summaries']) && Array.isArray(value.zone_summaries) &&
        value.zone_summaries.every((item) => exactKeys(item, ['zone', 'count', 'total_amount']) &&
          typeof item.zone === 'string' && Number.isInteger(item.count) && typeof item.total_amount === 'number');
    case 'MD-CROSS-05':
      return exactKeys(value, ['event_pairs']) && Array.isArray(value.event_pairs) &&
        value.event_pairs.every((pair) => stringsOnly(pair) && pair.length === 2);
    case 'MD-GRAPH-06':
      return exactKeys(value, ['out_degree', 'reachable_from_n1_in_two_hops']) &&
        Array.isArray(value.out_degree) && value.out_degree.every((item) =>
          exactKeys(item, ['node', 'degree']) && typeof item.node === 'string' && Number.isInteger(item.degree)) &&
        stringsOnly(value.reachable_from_n1_in_two_hops);
    case 'MD-TOOL-07':
      return exactKeys(value, ['tool', 'arguments']) && value.tool === 'dispatch_visit' &&
        exactKeys(value.arguments, ['ticket_id', 'recipient', 'service_zone']) &&
        typeof value.arguments.ticket_id === 'string' && typeof value.arguments.recipient === 'string' &&
        typeof value.arguments.service_zone === 'string';
    default:
      return false;
  }
}

function notApplicableRestore() {
  return {applicable: false, restored_items: 0, correctly_restored_items: 0, exact_match_rate: null,
    unknown_token_count: 0, accidental_raw_output_count: 0};
}

function rawOccurrenceIds(oracleCase, value) {
  return oracleCase.sensitive_entities.filter((entity) => entity.raw_value === value).map((entity) => entity.occurrence_id);
}

function rawToolLedger(fixtureMeta, oracleCase, transformed, value, occurrenceIds, requirementId) {
  return ledgerEntry(fixtureMeta, oracleCase.task_id, transformed.strategy, 'TOOL', {
    source_occurrence_ids: occurrenceIds,
    representation: 'RAW_VALUE',
    disclosed_name: 'recipient',
    disclosed_value: value,
    requirement_id: requirementId
  });
}

function restoreToolOutput(fixtureMeta, oracleCase, candidate, transformed) {
  const restoredOutput = clone(candidate);
  const metrics = notApplicableRestore();
  const toolLedger = [];
  const recipient = candidate.arguments.recipient;
  const rawRecipient = oracleCase.ground_truth.arguments.recipient;
  const directRawOccurrences = rawOccurrenceIds(oracleCase, recipient);
  const rawWasAgentVisible = transformed.agent_ledger.some((entry) =>
    entry.representation === 'RAW_VALUE' && entry.disclosed_value === recipient);

  if (transformed.strategy === 'RAW_DISCLOSURE') {
    if (directRawOccurrences.length > 0) {
      toolLedger.push(rawToolLedger(fixtureMeta, oracleCase, transformed, recipient, directRawOccurrences, null));
    }
    return {restoredOutput, restoreCorrectness: metrics, toolLedger};
  }

  if (transformed.token_to_raw.size === 0) {
    if (directRawOccurrences.length > 0) {
      metrics.accidental_raw_output_count = rawWasAgentVisible ? 0 : 1;
      toolLedger.push(rawToolLedger(fixtureMeta, oracleCase, transformed, recipient, directRawOccurrences, null));
    }
    return {restoredOutput, restoreCorrectness: metrics, toolLedger};
  }

  metrics.applicable = true;
  if (transformed.token_to_raw.has(recipient)) {
    const rawValue = transformed.token_to_raw.get(recipient);
    restoredOutput.arguments.recipient = rawValue;
    metrics.restored_items = 1;
    metrics.correctly_restored_items = rawValue === rawRecipient ? 1 : 0;
    metrics.exact_match_rate = metrics.correctly_restored_items;
    toolLedger.push(rawToolLedger(fixtureMeta, oracleCase, transformed, rawValue,
      transformed.token_to_occurrences.get(recipient) ?? [],
      transformed.strategy === 'ORACLE_MIN_DISCLOSURE' ? 'req_tool_recipient' : null));
  } else if (/^<E_\d{3}>$/.test(recipient)) {
    metrics.unknown_token_count = 1;
  } else if (directRawOccurrences.length > 0) {
    metrics.accidental_raw_output_count = rawWasAgentVisible ? 0 : 1;
    toolLedger.push(rawToolLedger(fixtureMeta, oracleCase, transformed, recipient, directRawOccurrences, null));
  }
  return {restoredOutput, restoreCorrectness: metrics, toolLedger};
}

function falseChecks(oracleCase) {
  return Object.fromEntries(oracleCase.oracle.relationship_checks.map((name) => [name, false]));
}

function relationshipChecks(oracleCase, candidate, restoredOutput, schemaValid) {
  if (!schemaValid) return falseChecks(oracleCase);
  const truth = oracleCase.ground_truth;
  switch (oracleCase.task_id) {
    case 'MD-EQ-01':
      return {equality_preserved: isDeepStrictEqual(candidate.duplicate_groups, truth.duplicate_groups)};
    case 'MD-GROUP-02':
      return {grouping_preserved: isDeepStrictEqual(candidate.groups.map((g) => g.invoice_ids), truth.groups.map((g) => g.invoice_ids)),
        aggregate_values_correct: isDeepStrictEqual(candidate.groups.map((g) => g.total_amount), truth.groups.map((g) => g.total_amount))};
    case 'MD-ORDER-03':
      return {ordering_preserved: isDeepStrictEqual(candidate.ordered_record_ids, truth.ordered_record_ids)};
    case 'MD-LOC-04':
      return {grouping_preserved: isDeepStrictEqual(candidate.zone_summaries.map((i) => [i.zone, i.count]), truth.zone_summaries.map((i) => [i.zone, i.count])),
        aggregate_values_correct: isDeepStrictEqual(candidate.zone_summaries.map((i) => i.total_amount), truth.zone_summaries.map((i) => i.total_amount))};
    case 'MD-CROSS-05':
      return {identity_preserved: isDeepStrictEqual(candidate.event_pairs, truth.event_pairs),
        window_relation_preserved: isDeepStrictEqual(candidate.event_pairs, truth.event_pairs)};
    case 'MD-GRAPH-06':
      return {source_edges_preserved: candidate.out_degree.length === truth.out_degree.length,
        graph_computation_correct: isDeepStrictEqual(candidate, truth)};
    case 'MD-TOOL-07':
      return {selection_preserved: candidate.arguments.ticket_id === truth.arguments.ticket_id,
        tool_argument_property_preserved: candidate.arguments.service_zone === truth.arguments.service_zone,
        exact_recipient_after_restore: restoredOutput.arguments.recipient === truth.arguments.recipient};
    default:
      return falseChecks(oracleCase);
  }
}

function noToolStatus() { return {tool_invoked: false, tool_call_valid: null, tool_call_correct: null}; }

function evaluateOutput(fixtureMeta, oracleCase, candidate, transformed) {
  if (Object.keys(oracleCase).some((key) => !ORACLE_INPUT_KEYS.includes(key))) {
    throw new Error('oracle received a field outside its frozen input projection');
  }
  const schemaValid = validateOutputSchema(oracleCase.task_id, candidate);
  if (!schemaValid) {
    return {task_success: false, validity: 'schema_invalid', restored_output: null,
      relationship_checks: falseChecks(oracleCase), restore_correctness: notApplicableRestore(), tool_ledger: [],
      tool_status: oracleCase.task_id === 'MD-TOOL-07'
        ? {tool_invoked: false, tool_call_valid: false, tool_call_correct: false} : noToolStatus()};
  }

  let restoredOutput = clone(candidate);
  let restoreCorrectness = notApplicableRestore();
  let toolLedger = [];
  if (oracleCase.task_id === 'MD-TOOL-07') {
    const restored = restoreToolOutput(fixtureMeta, oracleCase, candidate, transformed);
    restoredOutput = restored.restoredOutput;
    restoreCorrectness = restored.restoreCorrectness;
    toolLedger = restored.toolLedger;
  }
  const rawViolation = restoreCorrectness.accidental_raw_output_count > 0;
  const taskSuccess = !rawViolation && isDeepStrictEqual(restoredOutput, oracleCase.ground_truth);
  return {task_success: taskSuccess, validity: 'valid', restored_output: restoredOutput,
    relationship_checks: relationshipChecks(oracleCase, candidate, restoredOutput, true),
    restore_correctness: restoreCorrectness, tool_ledger: toolLedger,
    tool_status: oracleCase.task_id === 'MD-TOOL-07'
      ? {tool_invoked: true, tool_call_valid: true, tool_call_correct: taskSuccess} : noToolStatus()};
}

module.exports = {ORACLE_INPUT_KEYS, evaluateOutput, projectOracleCase, validateOutputSchema};
