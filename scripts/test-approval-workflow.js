/**
 * Offline test harness for workflows/02-approval-workflow.json's Code nodes -
 * mirrors test-clean-validate.js's approach (execute the exact jsCode shipped
 * in the export against mocked upstream node outputs) to verify the
 * approver-resolution and context-reattachment logic without a live n8n run.
 *
 * Usage: node test-approval-workflow.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', '02-approval-workflow.json'), 'utf8'));
const departments = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database', 'seed-departments.json'), 'utf8'));

function getNodeCode(name) {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`Node not found: ${name}`);
  return n.parameters.jsCode;
}

function runCodeNode(jsCode, inputItems, env, refs) {
  const sandbox = {
    $input: { all: () => inputItems },
    $env: env || {},
    $json: inputItems[0] ? inputItems[0].json : {},
    $: (name) => {
      if (!refs || !refs[name]) throw new Error(`No mock registered for $('${name}')`);
      return refs[name];
    },
    console, JSON, Math, Array, Number, String, Boolean, Date,
  };
  vm.createContext(sandbox);
  return vm.runInContext(`(function(){\n${jsCode}\n})()`, sandbox);
}

let passed = 0, failed = 0;
function check(desc, cond) {
  if (cond) { passed++; console.log('  PASS -', desc); }
  else { failed++; console.log('  FAIL -', desc); }
}

// --- Resolve Approvers Per Invoice: multi-department routing ---------------
console.log('\n[1] Resolve Approvers Per Invoice - invoice routed to Finance + IT');
{
  const code = getNodeCode('Resolve Approvers Per Invoice');
  const invoiceItem = {
    json: {
      Id: 7, Vendor: 'Northwind Office Supplies Pvt Ltd', InvoiceNumber: 'INV-2026-0143',
      GrossAmount: 696.15, Currency: 'EUR', CostCenter: 'FAC-OPS-04',
      Anomalies: '[]', SelectedDepartments: 'Finance,IT', ApprovalToken: '',
    },
  };
  const out = runCodeNode(code, [invoiceItem], {}, {
    'NocoDB - Get All Departments': { first: () => ({ json: { list: departments } }) },
  });
  check('resolved 2 approvers', out[0].json.approvers.length === 2);
  check('Finance approver resolved correctly', out[0].json.approvers.some(a => a.department === 'Finance' && a.approverEmail === 'finance-approver@example.com'));
  check('IT approver resolved correctly', out[0].json.approvers.some(a => a.department === 'IT' && a.approverEmail === 'it-approver@example.com'));
  check('approvalToken generated when invoice had none', typeof out[0].json.approvalToken === 'string' && out[0].json.approvalToken.length === 24);
}

console.log('\n[2] Resolve Approvers Per Invoice - unknown department is silently skipped, not crashed');
{
  const code = getNodeCode('Resolve Approvers Per Invoice');
  const invoiceItem = { json: { Id: 8, SelectedDepartments: 'Legal', ApprovalToken: 'EXISTINGTOKEN0000000000' } };
  const out = runCodeNode(code, [invoiceItem], {}, {
    'NocoDB - Get All Departments': { first: () => ({ json: { list: departments } }) },
  });
  check('no approvers resolved for unknown department', out[0].json.approvers.length === 0);
  check('existing approvalToken preserved (not regenerated)', out[0].json.approvalToken === 'EXISTINGTOKEN0000000000');
}

// --- Reattach Context After Token Persist -----------------------------------
console.log('\n[3] Reattach Context After Token Persist - restores fields lost by the PATCH response');
{
  const code = getNodeCode('Reattach Context After Token Persist');
  const resolveOutput = [{ json: { invoiceId: 7, vendor: 'Northwind', approvalToken: 'TOK123', approvers: [{ department: 'Finance' }] } }];
  const patchResponse = [{ json: { Id: 7 } }]; // NocoDB PATCH response - only echoes the Id
  const out = runCodeNode(code, patchResponse, {}, {
    'Resolve Approvers Per Invoice': { all: () => resolveOutput },
  });
  check('vendor field restored after PATCH response overwrote $json', out[0].json.vendor === 'Northwind');
  check('approvers array restored after PATCH response overwrote $json', out[0].json.approvers.length === 1);
}

// --- Reattach Context After Slack / Email -----------------------------------
console.log('\n[4] Reattach Context After Slack - restores fields lost by the Slack API response');
{
  const code = getNodeCode('Reattach Context After Slack');
  const linksOutput = [{ json: { invoiceId: 7, approvers: { department: 'Finance', approverEmail: 'finance-approver@example.com' }, approveUrl: 'http://x/approve' } }];
  const slackResponse = [{ json: { ok: true, channel: 'U0FINANCE01', ts: '123.456' } }];
  const out = runCodeNode(code, slackResponse, {}, {
    'Build Approval Links & Message': { all: () => linksOutput },
  });
  check('invoiceId restored after Slack response overwrote $json', out[0].json.invoiceId === 7);
  check('slackResult captured alongside restored context', out[0].json.slackResult.ok === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
