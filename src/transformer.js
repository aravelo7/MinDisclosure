'use strict';

const {REPRESENTATIONS, STRATEGIES} = require('./constants');

const TRANSFORMER_INPUT_KEYS = [
  'task_id',
  'raw_input',
  'sensitive_entities',
  'task_requirements',
  'oracle_disclosure_plan',
  'source_relations'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyCategoryCounts() {
  return Object.fromEntries(REPRESENTATIONS.map((name) => [name, 0]));
}

function projectTransformationCase(task, disclosurePlan = task.oracle_disclosure_plan) {
  const projected = Object.fromEntries(TRANSFORMER_INPUT_KEYS.map((key) => [
    key,
    clone(task[key] ?? (key === 'source_relations' ? [] : null))
  ]));
  projected.oracle_disclosure_plan = clone(disclosurePlan);
  return projected;
}

function pathParts(sourcePath) {
  const parts = [];
  const expression = /\.([A-Za-z0-9_]+)|\[(\d+)\]/g;
  let match;
  while ((match = expression.exec(sourcePath)) !== null) parts.push(match[1] ?? Number(match[2]));
  return parts;
}

function setAtPath(root, sourcePath, value) {
  const parts = pathParts(sourcePath);
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) cursor = cursor[parts[index]];
  cursor[parts.at(-1)] = value;
}

function ledgerEntry(fixtureMeta, taskId, strategy, boundary, item) {
  return {
    task_id: taskId,
    strategy,
    boundary,
    source_occurrence_ids: item.source_occurrence_ids,
    representation: item.representation,
    disclosed_name: item.disclosed_name,
    disclosed_value: item.disclosed_value,
    requirement_id: item.requirement_id ?? null,
    exposure_weight: fixtureMeta.exposure_weights[item.representation]
  };
}

function tokenFor(index) {
  return `<E_${String(index).padStart(3, '0')}>`;
}

function transformTask(fixtureMeta, transformationCase, strategy) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy: ${strategy}`);
  if (Object.keys(transformationCase).some((key) => !TRANSFORMER_INPUT_KEYS.includes(key))) {
    throw new Error('transformer received a field outside its frozen input projection');
  }

  const agentInput = clone(transformationCase.raw_input);
  const agentLedger = [];
  const identityToToken = new Map();
  const tokenToRaw = new Map();
  const tokenToOccurrences = new Map();
  const occurrenceIndexes = new Map(
    transformationCase.sensitive_entities.map((entity, index) => [entity.occurrence_id, index + 1])
  );
  let nextToken = 1;

  const entities = new Map(
    transformationCase.sensitive_entities.map((entity) => [entity.occurrence_id, entity])
  );
  const requirements = new Map(
    transformationCase.task_requirements.map((item) => [item.requirement_id, item])
  );

  function stableToken(entity, reversible) {
    const identity = entity.entity_identity ?? `raw:${entity.raw_value}`;
    if (!identityToToken.has(identity)) {
      identityToToken.set(identity, tokenFor(nextToken));
      nextToken += 1;
    }
    const token = identityToToken.get(identity);
    if (reversible) {
      tokenToRaw.set(token, entity.raw_value);
      const occurrences = tokenToOccurrences.get(token) ?? [];
      occurrences.push(entity.occurrence_id);
      tokenToOccurrences.set(token, occurrences);
    }
    return token;
  }

  function disclose(entity, representation, disclosedName, disclosedValue, requirementId) {
    setAtPath(agentInput, entity.source_path, disclosedValue);
    agentLedger.push(ledgerEntry(fixtureMeta, transformationCase.task_id, strategy, 'AGENT', {
      source_occurrence_ids: [entity.occurrence_id],
      representation,
      disclosed_name: disclosedName,
      disclosed_value: disclosedValue,
      requirement_id: requirementId
    }));
  }

  if (strategy === 'FIXED_REDACTION') {
    transformationCase.sensitive_entities.forEach((entity, index) => {
      disclose(entity, 'REDACTED', 'redacted', `<REDACTED_${String(index + 1).padStart(3, '0')}>`, null);
    });
  } else if (strategy === 'STABLE_TOKENIZATION') {
    transformationCase.sensitive_entities.forEach((entity) => {
      disclose(entity, 'OPAQUE_TOKEN', 'identity_handle', stableToken(entity, true), null);
    });
  } else if (strategy === 'RAW_DISCLOSURE') {
    transformationCase.sensitive_entities.forEach((entity) => {
      disclose(entity, 'RAW_VALUE', 'raw_value', entity.raw_value, null);
    });
  } else {
    const seenOccurrences = new Set();
    for (const action of transformationCase.oracle_disclosure_plan.actions) {
      const entity = entities.get(action.occurrence_id);
      if (!entity || seenOccurrences.has(entity.occurrence_id)) {
        throw new Error(`${transformationCase.task_id}: invalid or duplicate oracle action`);
      }
      seenOccurrences.add(entity.occurrence_id);
      if (!requirements.has(action.requirement_id)) {
        throw new Error(`${transformationCase.task_id}: disclosure has no task requirement`);
      }

      if (action.representation === 'OPAQUE_TOKEN') {
        disclose(entity, 'OPAQUE_TOKEN', 'identity_handle', stableToken(entity, Boolean(action.reversible)), action.requirement_id);
      } else if (action.representation === 'REDACTED') {
        const suffix = String(occurrenceIndexes.get(entity.occurrence_id)).padStart(3, '0');
        disclose(entity, 'REDACTED', 'redacted', `<REDACTED_${suffix}>`, action.requirement_id);
      } else if (action.representation === 'RAW_VALUE') {
        disclose(entity, 'RAW_VALUE', 'raw_value', entity.raw_value, action.requirement_id);
      } else if (['COARSENED_VALUE', 'DERIVED_PROPERTY'].includes(action.representation)) {
        if (!Object.hasOwn(entity.sensitive_properties, action.property_name)) {
          throw new Error(`${transformationCase.task_id}: missing field-local property ${action.property_name}`);
        }
        disclose(entity, action.representation, action.property_name,
          entity.sensitive_properties[action.property_name], action.requirement_id);
      } else {
        throw new Error(`${transformationCase.task_id}: unsupported occurrence action`);
      }
    }
    if (seenOccurrences.size !== transformationCase.sensitive_entities.length) {
      throw new Error(`${transformationCase.task_id}: oracle plan must cover every sensitive occurrence`);
    }
  }

  if (strategy !== 'FIXED_REDACTION') {
    for (const relation of transformationCase.source_relations) {
      agentLedger.push(ledgerEntry(fixtureMeta, transformationCase.task_id, strategy, 'AGENT', {
        source_occurrence_ids: relation.source_occurrence_ids,
        representation: 'RELATION_ONLY',
        disclosed_name: relation.name,
        disclosed_value: {source_relation_id: relation.relation_id},
        requirement_id: strategy === 'ORACLE_MIN_DISCLOSURE' ? relation.requirement_id : null
      }));
    }
  }

  return {
    task_id: transformationCase.task_id,
    strategy,
    agent_input: agentInput,
    agent_ledger: agentLedger,
    token_to_raw: tokenToRaw,
    token_to_occurrences: tokenToOccurrences
  };
}

module.exports = {
  TRANSFORMER_INPUT_KEYS,
  emptyCategoryCounts,
  ledgerEntry,
  projectTransformationCase,
  transformTask
};
