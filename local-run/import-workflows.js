const fs = require('fs');
const path = require('path');

const N8N_URL = process.env.N8N_URL || 'http://localhost:5678';
const API_KEY = fs.readFileSync(path.join(__dirname, 'n8n_api_key.txt'), 'utf8').trim();
const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');

const FILES = ['03-error-handler.json', '01-invoice-intake.json', '02-approval-workflow.json'];

async function importOne(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    console.error(`FAILED importing ${file}: ${res.status}`, JSON.stringify(json));
    return null;
  }
  console.log(`Imported ${file} -> id=${json.id} name="${json.name}"`);
  return json;
}

async function main() {
  const results = {};
  for (const file of FILES) {
    results[file] = await importOne(file);
  }
  fs.writeFileSync(path.join(__dirname, 'imported-workflow-ids.json'), JSON.stringify(results, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
