'use strict';

const SOLVER_INPUT_KEYS = ['task_id', 'user_instruction', 'agent_input'];

function projectSolverCase(task, transformed) {
  return {
    task_id: task.task_id,
    user_instruction: task.user_instruction,
    agent_input: JSON.parse(JSON.stringify(transformed.agent_input))
  };
}

function groupInOrder(items, keyOf) {
  const groups = [];
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!byKey.has(key)) {
      const group = {key, items: []};
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).items.push(item);
  }
  return groups;
}

function emailDomainOrHandle(value) {
  return typeof value === 'string' && value.includes('@') ? value.split('@').at(-1) : value;
}

function yearValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  const match = typeof value === 'string' ? value.match(/^(\d{4})/) : null;
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function serviceZone(value, zoneRule) {
  if (Object.hasOwn(zoneRule, value)) {
    return value;
  }
  for (const [zone, cities] of Object.entries(zoneRule)) {
    if (cities.some((city) => typeof value === 'string' && value.includes(city))) {
      return zone;
    }
  }
  return 'UNKNOWN';
}

function solveEquality(input) {
  return {
    duplicate_groups: groupInOrder(input.records, (record) => record.email)
      .map((group) => group.items.map((record) => record.record_id))
      .filter((ids) => ids.length > 1)
  };
}

function solveGrouping(input) {
  return {
    groups: groupInOrder(input.invoices, (invoice) => emailDomainOrHandle(invoice.contact_email))
      .map((group, index) => ({
        group_id: `g${index + 1}`,
        invoice_ids: group.items.map((invoice) => invoice.invoice_id),
        total_amount: group.items.reduce((sum, invoice) => sum + invoice.amount, 0)
      }))
  };
}

function solveOrdering(input) {
  return {
    ordered_record_ids: input.people
      .map((person, index) => ({person, index, year: yearValue(person.date_of_birth)}))
      .sort((left, right) => left.year - right.year || left.index - right.index)
      .map(({person}) => person.record_id)
  };
}

function solveLocation(input) {
  const summaries = Object.keys(input.zone_rule).map((zone) => ({zone, count: 0, total_amount: 0}));
  const byZone = new Map(summaries.map((item) => [item.zone, item]));
  for (const request of input.requests) {
    const zone = serviceZone(request.address, input.zone_rule);
    if (byZone.has(zone)) {
      byZone.get(zone).count += 1;
      byZone.get(zone).total_amount += request.amount;
    }
  }
  return {zone_summaries: summaries};
}

function solveCross(input) {
  const pairs = [];
  for (let left = 0; left < input.events.length; left += 1) {
    for (let right = left + 1; right < input.events.length; right += 1) {
      const first = input.events[left];
      const second = input.events[right];
      const firstTime = Date.parse(first.timestamp);
      const secondTime = Date.parse(second.timestamp);
      if (first.subject_email === second.subject_email &&
          Number.isFinite(firstTime) && Number.isFinite(secondTime) &&
          secondTime - firstTime <= 72 * 60 * 60 * 1000) {
        pairs.push([first.event_id, second.event_id]);
      }
    }
  }
  return {event_pairs: pairs};
}

function solveGraph(input) {
  const nodeIds = new Map();
  function nodeId(value) {
    if (!nodeIds.has(value)) {
      nodeIds.set(value, `n${nodeIds.size + 1}`);
    }
    return nodeIds.get(value);
  }
  const edges = input.edges.map((edge) => ({from: nodeId(edge.from), to: nodeId(edge.to)}));
  const nodes = [...nodeIds.values()];
  const outDegree = nodes.map((node) => ({
    node,
    degree: edges.filter((edge) => edge.from === node).length
  }));
  const oneHop = new Set(edges.filter((edge) => edge.from === 'n1').map((edge) => edge.to));
  const exactlyTwo = [];
  for (const edge of edges) {
    if (oneHop.has(edge.from) && !exactlyTwo.includes(edge.to)) {
      exactlyTwo.push(edge.to);
    }
  }
  return {out_degree: outDegree, reachable_from_n1_in_two_hops: exactlyTwo};
}

function solveTool(input) {
  const selected = input.tickets.reduce((best, ticket) => ticket.severity > best.severity ? ticket : best);
  return {
    tool: 'dispatch_visit',
    arguments: {
      ticket_id: selected.ticket_id,
      recipient: selected.recipient_email,
      service_zone: serviceZone(selected.address, input.zone_rule)
    }
  };
}

function solveTask(solverCase) {
  if (Object.keys(solverCase).some((key) => !SOLVER_INPUT_KEYS.includes(key))) {
    throw new Error('solver received a field outside its frozen input projection');
  }
  switch (solverCase.task_id) {
    case 'MD-EQ-01': return solveEquality(solverCase.agent_input);
    case 'MD-GROUP-02': return solveGrouping(solverCase.agent_input);
    case 'MD-ORDER-03': return solveOrdering(solverCase.agent_input);
    case 'MD-LOC-04': return solveLocation(solverCase.agent_input);
    case 'MD-CROSS-05': return solveCross(solverCase.agent_input);
    case 'MD-GRAPH-06': return solveGraph(solverCase.agent_input);
    case 'MD-TOOL-07': return solveTool(solverCase.agent_input);
    default: throw new Error(`unknown task: ${solverCase.task_id}`);
  }
}

module.exports = {SOLVER_INPUT_KEYS, projectSolverCase, solveTask};
