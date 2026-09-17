'use strict';

const path = require('node:path');
const {DEFAULT_EXPERIMENT_ID, runMockExperiment, writeArtifacts} = require('./llm-experiment');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0) throw new Error('usage: node src/run-llm-mock.js');
  const report = await runMockExperiment();
  const outputRoot = path.resolve(__dirname, '..', 'artifacts', 'llm', DEFAULT_EXPERIMENT_ID);
  writeArtifacts(report, outputRoot);
  process.stdout.write(`${JSON.stringify({output: outputRoot, ...report.summary})}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = {main};
