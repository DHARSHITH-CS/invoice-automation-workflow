/**
 * Builds a throwaway test workflow that reuses the REAL nodes from
 * 01-invoice-intake.json starting at "Clean & Validate Extracted Data" (i.e.
 * everything after the Gmail/PDF-extraction/OpenAI steps we can't exercise
 * without those credentials), fed by a Manual Trigger + a real PDF read from
 * disk + injected mock AI output taken from sample-ai-responses.json.
 *
 * This proves the NocoDB-writing half of the pipeline (cleaning, duplicate
 * detection, vendor validation, PDF upload, record creation, audit log)
 * against a real running NocoDB instance.
 */
const fs = require('fs');
const path = require('path');

const NOCODB_CRED_ID = process.argv[2];
const SAMPLE_KEY = process.argv[3] || 'sample-invoice-clean.pdf';
if (!NOCODB_CRED_ID) { console.error('usage: node build-test-intake.js <nocodb-cred-id> [sample-file]'); process.exit(1); }

const intake = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', '01-invoice-intake.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'sample-ai-responses.json'), 'utf8'));
const sample = samples[SAMPLE_KEY];
if (!sample) { console.error('unknown sample', SAMPLE_KEY); process.exit(1); }

const KEEP_FROM = 'Clean & Validate Extracted Data';
const keepNodes = intake.nodes.slice(intake.nodes.findIndex(n => n.name === KEEP_FROM));

// Re-wire credentials directly (this workflow is generated after fixup-credentials
// already ran against the real deliverable workflows, so do the same here).
for (const node of keepNodes) {
  if (node.credentials && node.credentials.httpHeaderAuth) {
    node.credentials.httpHeaderAuth = { id: NOCODB_CRED_ID, name: 'NocoDB API Token' };
  }
}

const pdfPath = path.resolve(__dirname, '..', 'sample-data', SAMPLE_KEY).replace(/\\/g, '\\\\');

const manualTrigger = {
  id: 'test-manual-trigger', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1,
  position: [-1200, 0], parameters: {},
};
const readFile = {
  id: 'test-read-pdf', name: 'Read Sample PDF', type: 'n8n-nodes-base.readWriteFile', typeVersion: 1,
  position: [-960, 0],
  parameters: { operation: 'read', fileSelector: pdfPath, options: { dataPropertyName: 'invoicePdf' } },
};
const injectMock = {
  id: 'test-inject-mock', name: 'Inject Mock AI Output', type: 'n8n-nodes-base.code', typeVersion: 2,
  position: [-720, 0],
  parameters: {
    jsCode: `
const sample = ${JSON.stringify(sample)};
return $input.all().map(item => ({
  json: {
    sender: '"Test Sender" <billing@example.com>',
    senderEmail: 'billing@example.com',
    senderName: 'Test Sender',
    subject: 'Invoice ${SAMPLE_KEY}',
    receivedAt: new Date().toISOString(),
    fileName: '${SAMPLE_KEY}',
    extracted: sample,
    aiCallFailed: false,
  },
  binary: item.binary,
}));
`.trim(),
  },
};

const nodes = [manualTrigger, readFile, injectMock, ...keepNodes];
const connections = {
  'Manual Trigger': { main: [[{ node: 'Read Sample PDF', type: 'main', index: 0 }]] },
  'Read Sample PDF': { main: [[{ node: 'Inject Mock AI Output', type: 'main', index: 0 }]] },
  'Inject Mock AI Output': { main: [[{ node: KEEP_FROM, type: 'main', index: 0 }]] },
};
// Bring over the original connections for the kept nodes.
for (const [name, conn] of Object.entries(intake.connections)) {
  if (keepNodes.some(n => n.name === name)) connections[name] = conn;
}

const testWorkflow = {
  name: `TEST - Invoice Intake (${SAMPLE_KEY})`,
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};

fs.writeFileSync(path.join(__dirname, `test-intake-workflow.json`), JSON.stringify(testWorkflow, null, 2));
console.log('wrote test-intake-workflow.json');
