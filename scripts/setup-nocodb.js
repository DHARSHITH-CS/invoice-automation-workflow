/**
 * Idempotent NocoDB schema bootstrap.
 *
 * Creates (if not already present) the base "InvoiceAutomation" and its four
 * tables (Vendors, Departments, Invoices, Audit_Log) with the fields
 * described in database/schema.md, then loads database/seed-vendors.json and
 * database/seed-departments.json.
 *
 * Usage:
 *   NOCODB_BASE_URL=http://localhost:8080 NOCODB_ADMIN_EMAIL=admin@example.com \
 *   NOCODB_ADMIN_PASSWORD=ChangeMe123! node setup-nocodb.js
 *
 * On success it prints the table IDs to paste into docker/.env
 * (NOCODB_TABLE_INVOICES etc.) and into n8n credentials/environment.
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.NOCODB_BASE_URL || 'http://localhost:8080';
const ADMIN_EMAIL = process.env.NOCODB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.NOCODB_ADMIN_PASSWORD;
const API_TOKEN = process.env.NOCODB_API_TOKEN; // alternative to admin email/password

if (!API_TOKEN && (!ADMIN_EMAIL || !ADMIN_PASSWORD)) {
  console.error('Set NOCODB_API_TOKEN, or NOCODB_ADMIN_EMAIL + NOCODB_ADMIN_PASSWORD.');
  process.exit(1);
}

async function req(method, urlPath, body, token) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'xc-auth': token, 'xc-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getAuthToken() {
  if (API_TOKEN) return API_TOKEN;
  const signin = await req('POST', '/api/v1/auth/user/signin', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return signin.token;
}

const COLUMN_TYPES = {
  text: 'SingleLineText',
  longText: 'LongText',
  number: 'Number',
  decimal: 'Decimal',
  percent: 'Percent',
  checkbox: 'Checkbox',
  date: 'Date',
  dateTime: 'DateTime',
  email: 'Email',
  singleSelect: 'SingleSelect',
  multiSelect: 'MultiSelect',
  attachment: 'Attachment',
};

function col(title, uidt, extra) {
  return { title, uidt, ...(extra || {}) };
}

const TABLES = {
  Vendors: {
    columns: [
      col('VendorName', COLUMN_TYPES.text),
      col('VendorUID', COLUMN_TYPES.text),
      col('VendorIBAN', COLUMN_TYPES.text),
      col('Status', COLUMN_TYPES.singleSelect, { dtxp: "'Active','Blocked','Unverified'" }),
      col('Notes', COLUMN_TYPES.longText),
    ],
  },
  Departments: {
    columns: [
      col('DepartmentName', COLUMN_TYPES.text),
      col('ApproverName', COLUMN_TYPES.text),
      col('ApproverEmail', COLUMN_TYPES.email),
      col('ApproverSlackId', COLUMN_TYPES.text),
      col('ApprovalThreshold', COLUMN_TYPES.decimal),
    ],
  },
  Invoices: {
    columns: [
      col('Vendor', COLUMN_TYPES.text),
      col('VendorUID', COLUMN_TYPES.text),
      col('VendorIBAN', COLUMN_TYPES.text),
      col('InvoiceNumber', COLUMN_TYPES.text),
      col('InvoiceDate', COLUMN_TYPES.date),
      col('DueDate', COLUMN_TYPES.date),
      col('NetAmount', COLUMN_TYPES.decimal),
      col('VATAmount', COLUMN_TYPES.decimal),
      col('VATPercent', COLUMN_TYPES.percent),
      col('GrossAmount', COLUMN_TYPES.decimal),
      col('Currency', COLUMN_TYPES.text),
      col('CostCenter', COLUMN_TYPES.text),
      col('LineItems', COLUMN_TYPES.longText),
      col('Confidence', COLUMN_TYPES.decimal),
      col('Anomalies', COLUMN_TYPES.longText),
      col('ApplicationStatus', COLUMN_TYPES.singleSelect, { dtxp: "'Draft','Fully Approved','Rejected'" }),
      col('SelectedDepartments', COLUMN_TYPES.multiSelect, { dtxp: "'Finance','IT','Operations','Marketing','HR','Procurement'" }),
      col('SendForApproval', COLUMN_TYPES.checkbox),
      col('ReviewRequired', COLUMN_TYPES.checkbox),
      col('IsDuplicate', COLUMN_TYPES.checkbox),
      col('DuplicateOfId', COLUMN_TYPES.number),
      col('ApprovalToken', COLUMN_TYPES.text),
      col('Source', COLUMN_TYPES.text),
      col('Sender', COLUMN_TYPES.text),
      col('SenderEmail', COLUMN_TYPES.email),
      col('SenderName', COLUMN_TYPES.text),
      col('EmailSubject', COLUMN_TYPES.text),
      col('EmailReceived', COLUMN_TYPES.checkbox),
      col('ReceivedAt', COLUMN_TYPES.dateTime),
      col('PDFAttachment', COLUMN_TYPES.attachment),
    ],
  },
  Audit_Log: {
    columns: [
      col('InvoiceId', COLUMN_TYPES.number),
      col('Action', COLUMN_TYPES.singleSelect, {
        dtxp: "'Email_Received','PDF_Extracted','AI_Extraction_Success','AI_Extraction_Failed','Duplicate_Flagged','Record_Created','Reviewed','Sent_For_Approval','Approved','Rejected','Error','Retry'",
      }),
      col('Actor', COLUMN_TYPES.text),
      col('Details', COLUMN_TYPES.longText),
    ],
  },
};

async function main() {
  const token = await getAuthToken();
  console.log('Authenticated with NocoDB.');

  const bases = await req('GET', '/api/v1/db/meta/projects/', null, token);
  let base = (bases.list || []).find(b => b.title === 'InvoiceAutomation');
  if (!base) {
    base = await req('POST', '/api/v1/db/meta/projects/', { title: 'InvoiceAutomation' }, token);
    console.log('Created base InvoiceAutomation.');
  } else {
    console.log('Base InvoiceAutomation already exists, reusing.');
  }

  const existingTables = await req('GET', `/api/v1/db/meta/projects/${base.id}/tables`, null, token);
  const tableIds = {};

  for (const [tableName, def] of Object.entries(TABLES)) {
    let table = (existingTables.list || []).find(t => t.title === tableName);
    if (!table) {
      table = await req('POST', `/api/v1/db/meta/projects/${base.id}/tables`, {
        table_name: tableName,
        title: tableName,
        columns: [
          { title: 'Id', uidt: 'ID', pk: true, ai: true },
          ...def.columns,
        ],
      }, token);
      console.log(`Created table ${tableName} (id=${table.id})`);
    } else {
      console.log(`Table ${tableName} already exists (id=${table.id}), skipping column creation.`);
    }
    tableIds[tableName] = table.id;
  }

  // Seed reference data (idempotent-ish: only seeds if table currently empty).
  async function seedIfEmpty(tableName, seedFile) {
    const rows = await req('GET', `/api/v2/tables/${tableIds[tableName]}/records?limit=1`, null, token);
    if ((rows.list || []).length > 0) {
      console.log(`${tableName} already has data, skipping seed.`);
      return;
    }
    const seedPath = path.join(__dirname, '..', 'database', seedFile);
    const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    for (const record of seedData) {
      await req('POST', `/api/v2/tables/${tableIds[tableName]}/records`, record, token);
    }
    console.log(`Seeded ${seedData.length} rows into ${tableName}.`);
  }

  await seedIfEmpty('Vendors', 'seed-vendors.json');
  await seedIfEmpty('Departments', 'seed-departments.json');

  console.log('\nDone. Add these to docker/.env (or n8n environment variables):\n');
  console.log(`NOCODB_TABLE_INVOICES=${tableIds.Invoices}`);
  console.log(`NOCODB_TABLE_DEPARTMENTS=${tableIds.Departments}`);
  console.log(`NOCODB_TABLE_VENDORS=${tableIds.Vendors}`);
  console.log(`NOCODB_TABLE_AUDITLOG=${tableIds.Audit_Log}`);
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
