'use strict';

// Usage:
//   node scripts/render-report.js <discovery|final> <data.json> <template.html> <output.html> [cleanup-results.json]

const fs = require('fs');

const [mode, dataPath, templatePath, outputPath, resultsPath] = process.argv.slice(2);
const PLACEHOLDER = '__REPORT_DATA_JSON__';

if (!['discovery', 'final'].includes(mode) || !dataPath || !templatePath || !outputPath) {
  console.error('Usage: node render-report.js <discovery|final> <data.json> <template.html> <output.html> [results.json]');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
data.reportType = mode;
data.reportGeneratedAt = new Date().toISOString();

if (mode === 'final') {
  const results = resultsPath && fs.existsSync(resultsPath)
    ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')).results || []
    : [];
  const byBranch = new Map(results.map(r => [r.branch, r]));

  for (const branch of data.branches) {
    const result = byBranch.get(branch.branch);
    branch.deletionStatus = result ? result.status : 'NOT_ATTEMPTED';
    branch.deletionReason = result
      ? result.reason
      : 'Cleanup was rejected, skipped or produced no result';
  }
  data.cleanupResults = results;
}

const template = fs.readFileSync(templatePath, 'utf8');
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`Template is missing ${PLACEHOLDER}`);
}

// Escape "<" so branch names can never close the <script> tag, and use a
// replacer function so "$&"-style sequences in the data are not interpreted.
const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
fs.writeFileSync(outputPath, template.replace(PLACEHOLDER, () => safeJson), 'utf8');
console.log(`Generated ${outputPath} (${mode})`);