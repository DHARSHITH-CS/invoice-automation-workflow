/**
 * Offline test harness: extracts the exact jsCode string from
 * workflows/01-invoice-intake.json for the "Clean & Validate Extracted Data",
 * "Apply Duplicate Flag", and "Apply Vendor Validation" nodes, and executes
 * them against sample-data/sample-ai-responses.json to prove the business
 * logic is correct WITHOUT needing a running n8n/OpenAI/NocoDB instance.
 *
 * This is not a replacement for a live end-to-end run (see README's Docker
 * setup) - it's a fast, dependency-free correctness check of the same code
 * that ships inside the workflow export.
 *
 * Usage: node test-clean-validate.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const wfPath = path.join(__dirname, '..', 'workflows', '01-invoice-intake.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

function getNodeCode(name) {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`Node not found: ${name}`);
  return n.parameters.jsCode;
}

function runCodeNode(jsCode, inputItems, env, extraGlobals) {
  const sandbox = {
    $input: { all: () => inputItems },
    $env: env || {},
    $json: inputItems[0] ? inputItems[0].json : {},
    console,
    JSON,
    Math,
    Array,
    Number,
    String,
    Boolean,
    Date,
    ...extraGlobals,
  };
  vm.createContext(sandbox);
  const wrapped = `(function(){\n${jsCode}\n})()`;
  return vm.runInContext(wrapped, sandbox);
}

const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'sample-ai-responses.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(desc, cond) {
  if (cond) { passed++; console.log('  PASS -', desc); }
  else { failed++; console.log('  FAIL -', desc); }
}

// --- Test 1: clean invoice --------------------------------------------------
console.log('\n[1] sample-invoice-clean.pdf through Clean & Validate Extracted Data');
{
  const cleanCode = getNodeCode('Clean & Validate Extracted Data');
  const input = [{ json: { extracted: samples['sample-invoice-clean.pdf'], aiCallFailed: false } }];
  const out = runCodeNode(cleanCode, input, { CONFIDENCE_REVIEW_THRESHOLD: '0.75' });
  const clean = out[0].json.clean;
  check('vendor extracted', clean.vendor === 'Northwind Office Supplies Pvt Ltd');
  check('gross amount correct', clean.grossAmount === 696.15);
  check('no anomalies for a reconciled invoice', clean.anomalies.length === 0);
  check('reviewRequired is false (confidence 0.97 >= 0.75)', clean.reviewRequired === false);
  check('2 line items kept', clean.lineItems.length === 2);
  check('approvalToken generated', typeof clean.approvalToken === 'string' && clean.approvalToken.length === 24);
}

// --- Test 2: missing fields / reconciliation mismatch -----------------------
console.log('\n[2] sample-invoice-missing-fields.pdf through Clean & Validate Extracted Data');
{
  const cleanCode = getNodeCode('Clean & Validate Extracted Data');
  const input = [{ json: { extracted: samples['sample-invoice-missing-fields.pdf'], aiCallFailed: false } }];
  const out = runCodeNode(cleanCode, input, { CONFIDENCE_REVIEW_THRESHOLD: '0.75' });
  const clean = out[0].json.clean;
  check('reviewRequired true (confidence 0.55 < 0.75)', clean.reviewRequired === true);
  check('gross-mismatch anomaly detected', clean.anomalies.some(a => a.includes('does not equal Net + VAT')));
  check('vendorIban left empty, not fabricated', clean.vendorIban === '');
}

// --- Test 3: duplicate detection --------------------------------------------
console.log('\n[3] Apply Duplicate Flag - simulated NocoDB search HIT');
{
  const dupCode = getNodeCode('Apply Duplicate Flag');
  // Simulate the upstream "Clean & Validate Extracted Data" node's output via $('...').all()
  const cleanNodeOutput = [{ json: { clean: { vendorUid: 'VEN-1001', invoiceNumber: 'INV-2026-0143', anomalies: [], reviewRequired: false } } }];
  const input = [{ json: { list: [{ Id: 42 }] } }]; // NocoDB search returned an existing match
  const out = runCodeNode(dupCode, input, {}, {
    $: (name) => ({ all: () => cleanNodeOutput }),
  });
  const clean = out[0].json.clean;
  check('isDuplicate flagged true', clean.isDuplicate === true);
  check('duplicateOfId captured', clean.duplicateOfId === 42);
  check('reviewRequired forced true on duplicate', clean.reviewRequired === true);
}

console.log('\n[4] Apply Duplicate Flag - simulated NocoDB search MISS');
{
  const dupCode = getNodeCode('Apply Duplicate Flag');
  const cleanNodeOutput = [{ json: { clean: { vendorUid: 'VEN-1002', invoiceNumber: 'BW-77821', anomalies: [], reviewRequired: false } } }];
  const input = [{ json: { list: [] } }];
  const out = runCodeNode(dupCode, input, {}, {
    $: (name) => ({ all: () => cleanNodeOutput }),
  });
  check('isDuplicate stays false when no match found', out[0].json.clean.isDuplicate === false);
}

// --- Test 5: vendor master validation (blocked vendor) ----------------------
console.log('\n[5] Apply Vendor Validation - blocked vendor');
{
  const vendorCode = getNodeCode('Apply Vendor Validation');
  const dupNodeOutput = [{ json: { clean: { vendor: 'Suspicious Traders Co', vendorUid: 'VEN-9999', vendorIban: 'XX00000000000000000000', anomalies: [], reviewRequired: false } } }];
  const input = [{ json: { list: [{ Status: 'Blocked', VendorIBAN: 'XX00000000000000000000' }] } }];
  const out = runCodeNode(vendorCode, input, {}, {
    $: (name) => ({ all: () => dupNodeOutput }),
  });
  const clean = out[0].json.clean;
  check('blocked-vendor anomaly added', clean.anomalies.some(a => a.includes('BLOCKED')));
  check('reviewRequired forced true for blocked vendor', clean.reviewRequired === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
