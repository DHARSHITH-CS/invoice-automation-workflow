const fs = require('fs');
const path = require('path');

const N8N_URL = 'http://localhost:5678';
const API_KEY = fs.readFileSync(path.join(__dirname, 'n8n_api_key.txt'), 'utf8').trim();
const ids = JSON.parse(fs.readFileSync(path.join(__dirname, 'imported-workflow-ids.json'), 'utf8'));

const NOCODB_CRED_ID = process.argv[2];
if (!NOCODB_CRED_ID) { console.error('usage: node fixup-credentials.js <nocodb-credential-id>'); process.exit(1); }

async function fixupWorkflow(file, meta) {
  if (!meta) return;
  const getRes = await fetch(`${N8N_URL}/api/v1/workflows/${meta.id}`, { headers: { 'X-N8N-API-KEY': API_KEY } });
  const wf = await getRes.json();

  let changed = 0;
  for (const node of wf.nodes) {
    if (node.credentials && node.credentials.httpHeaderAuth && node.credentials.httpHeaderAuth.name === 'NocoDB API Token') {
      node.credentials.httpHeaderAuth = { id: NOCODB_CRED_ID, name: 'NocoDB API Token' };
      changed++;
    }
  }

  if (changed === 0) { console.log(`${file}: no NocoDB nodes found`); return; }

  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
  const putRes = await fetch(`${N8N_URL}/api/v1/workflows/${meta.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': API_KEY },
    body: JSON.stringify(body),
  });
  const text = await putRes.text();
  if (!putRes.ok) { console.error(`${file}: FAILED to update -`, text); return; }
  console.log(`${file}: wired NocoDB credential into ${changed} node(s)`);
}

async function main() {
  for (const [file, meta] of Object.entries(ids)) {
    await fixupWorkflow(file, meta);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
