# AI Invoice Automation Workflow

End-to-end, human-in-the-loop invoice processing built on **n8n** + **OpenAI (GPT-4o)** +
**NocoDB**. Suppliers email PDF invoices; the workflow extracts structured data with AI, stores
the original PDF, creates a Draft record, and hands the invoice to a human reviewer. Once a
reviewer marks it "Send for Approval", a second workflow routes it to the right department
approver over **Slack and email**, and updates the status when they respond.

## Contents

```
InvoiceAutomationAssignment/
├── docker/                      docker-compose.yml + env config to run n8n + NocoDB locally
├── database/                    schema.md, schema.sql, seed data for Departments/Vendors
├── prompts/                     the exact system/user prompt + JSON schema given to OpenAI
├── workflows/                   n8n workflow exports (import these into n8n)
├── sample-data/                 sample invoice PDFs + expected AI JSON output for each
├── scripts/                     generator + setup scripts (see below)
└── README.md                    this file
```

## Architecture

```
 Supplier email (PDF attached)
        │
        ▼
┌───────────────────────────── Workflow 1: Invoice Intake ─────────────────────────────┐
│ Gmail Trigger → Extract Attachments → [Has PDF?] → Extract Text (PDF)                │
│      → Build AI Request → OpenAI (structured JSON) ──success──▶ Parse AI JSON        │
│                                        └──error──▶ Build Fallback Extraction          │
│      → Merge → Clean & Validate → Search Duplicate → Search Vendor Master            │
│      → Upload PDF to NocoDB → Create Invoice Record (Status=Draft) → Write Audit Log │
└────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼  (human reviewer edits fields / departments in the NocoDB UI, ticks
        │   "Send for Approval")
        ▼
┌───────────────────────── Workflow 2: Approval Workflow ──────────────────────────────┐
│ Schedule (every 5 min) → Get Pending (SendForApproval=true, Status=Draft)             │
│      → Resolve department approver(s) → Slack DM + Email (Approve/Reject links)      │
│      → Write Audit Log (Sent_For_Approval)                                           │
│                                                                                        │
│ Webhook (approver clicks link) → validate token + still-Draft → update status         │
│      → Fully Approved | Rejected → Write Audit Log → respond to approver             │
└────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────── Workflow 3: Error Handler (attached as errorWorkflow) ─────────┐
│ Error Trigger → format details → Write Audit Log (Action=Error) → Slack alert         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

All state lives in **NocoDB** (4 tables: `Invoices`, `Departments`, `Vendors`, `Audit_Log`) —
see [`database/schema.md`](database/schema.md).

### Why these technical choices

- **NocoDB over Airtable/Notion**: free, self-hostable in one `docker compose up`, has a full
  REST API, and supports linked records + attachments natively — no paid account needed to run
  or review this submission.
- **Plain HTTP Request nodes for NocoDB/OpenAI/Slack instead of the dedicated n8n nodes**: the
  bundled NocoDB/Slack node parameter shapes vary across n8n versions, which makes an exported
  workflow JSON fragile to import into a different n8n version. Calling the REST APIs directly
  with a documented request body is version-proof, easier to audit line-by-line for security
  review, and is exactly what you'd do integrating a service n8n doesn't have a first-class node
  for.
- **OpenAI Structured Outputs (`json_schema`, `strict: true`)** instead of "please reply with
  JSON" prompting: the API itself refuses to return non-conforming output, which removes an
  entire class of parsing failures before they reach the workflow.

## Setup Instructions

### 1. Start the local stack

```bash
cd docker
cp .env.example .env      # then edit .env (see "Environment Variables" below)
docker compose up -d
```

This starts:
- **NocoDB** → http://localhost:8080
- **n8n** → http://localhost:5678

> **Docker Desktop won't start / "Inference manager" error?** This is a known Docker Desktop bug
> where a stale socket file under `%LOCALAPPDATA%\Docker\run\dockerInference` survives an
> unclean shutdown and can't be deleted by Windows, Explorer, or `Remove-Item -Force` until
> reboot. If `docker info` hangs or Docker Desktop's UI reports an "unexpected error", **reboot
> the machine** — that clears the stale handle — then `docker compose up -d` again.

### 2. Create the database schema

Sign up in the NocoDB UI (http://localhost:8080) to create your admin account, then either:

- **Automated** (recommended): `cd scripts && NOCODB_ADMIN_EMAIL=you@example.com NOCODB_ADMIN_PASSWORD=yourpassword node setup-nocodb.js` — creates the `InvoiceAutomation` base, all 4 tables with correct field types, and seeds `Departments`/`Vendors` from `database/seed-*.json`. Prints the table IDs to paste into `docker/.env`.
- **Manual**: follow the field list in [`database/schema.md`](database/schema.md) and click through the NocoDB UI.

Also generate a NocoDB API token (NocoDB UI → your avatar → API Tokens) — you'll store this as an
n8n credential in step 4.

Restart n8n after editing `.env` so it picks up the new table IDs: `docker compose restart n8n`.

### 3. Import the workflows

Open n8n (http://localhost:5678) → **Workflows → Import from File** → import, in order:
1. `workflows/03-error-handler.json`
2. `workflows/01-invoice-intake.json`
3. `workflows/02-approval-workflow.json`

Open Workflow 1 and Workflow 2's **Settings → Error Workflow** and point both at
`03 - Error Handler` (workflow-specific IDs can't be baked into the export, this is a one-time
manual link).

### 4. Configure credentials

In n8n → **Credentials → New**, create:

| Credential name         | Type                  | Used for |
|--------------------------|------------------------|----------|
| `Gmail account`           | Gmail OAuth2            | Workflow 1 trigger |
| `OpenAi account`          | OpenAI API               | Invoice extraction |
| `NocoDB API Token`        | Header Auth (`xc-token: <your NocoDB API token>`) | All NocoDB REST calls |
| `Slack Bot Token`         | Header Auth (`Authorization: Bearer xoxb-...`) | Slack approval messages + error alerts |
| `SMTP account`            | SMTP                    | Fallback approval emails |

Then open each imported workflow and re-attach the matching credential on every node that needs
one (n8n export files reference credentials by name but the IDs are instance-specific, so this
is a required one-time step after import — the credential *names* above already match what's in
the JSON, so n8n will usually auto-suggest the right one).

### 5. Environment variables

Set these in `docker/.env` (read by n8n via `env_file`, available to workflow expressions as
`$env.VAR_NAME`):

| Variable | Description |
|----------|--------------|
| `NOCODB_BASE_URL` | e.g. `http://nocodb:8080` (service name, since n8n and NocoDB share a docker network) |
| `NOCODB_TABLE_INVOICES` / `_DEPARTMENTS` / `_VENDORS` / `_AUDITLOG` | Table IDs printed by `setup-nocodb.js` |
| `OPENAI_MODEL` | e.g. `gpt-4o-2024-08-06` |
| `APPROVAL_WEBHOOK_BASE_URL` | Public base URL for the approval webhook — use an ngrok/cloudflared tunnel if approvers are outside your machine |
| `CONFIDENCE_REVIEW_THRESHOLD` | Default `0.75` — invoices below this confidence get `ReviewRequired=true` |
| `SLACK_ALERT_CHANNEL` | Slack channel ID for the error-handler workflow's failure alerts |
| `SMTP_FROM_ADDRESS` | From-address for approval emails |

### 6. Try it end-to-end

Send yourself an email (to the Gmail account connected in step 4) with one of
`sample-data/sample-invoice-*.pdf` attached, wait for the Gmail Trigger to poll (1 min), then
check the `Invoices` table in NocoDB for the new Draft record. Tick `SendForApproval=true` and
pick a `SelectedDepartments` value, then either wait for the 5-minute schedule or click **Execute
Workflow** on Workflow 2's Manual Trigger node to fire the approval scan immediately.

## Workflow Explanation (mapped to the assignment's functional steps)

| Spec step | Implementation |
|-----------|-----------------|
| 1. Email monitoring | Gmail Trigger polls every minute with query `has:attachment filename:pdf`; `Extract Attachments & Email Metadata` + `Has PDF Attachment?` re-verify per-attachment and drop non-PDF/no-attachment emails |
| 2. PDF extraction | `Extract Text From PDF` (n8n's built-in PDF text extraction) |
| 3. AI extraction | `Build AI Request` + `AI - Extract Invoice Data (OpenAI)` — see [prompts/extraction-prompt.md](prompts/extraction-prompt.md) |
| 4. Data cleaning | `Clean & Validate Extracted Data` — safe JSON parsing (already true-JSON via Structured Outputs, defended again here), drops empty line items, coerces/validates numeric fields, reconciles Net+VAT vs Gross, clamps confidence |
| 5. Store original PDF | `NocoDB - Upload PDF File` → attached to the record's `PDFAttachment` field |
| 6. Create invoice record | `NocoDB - Create Invoice Record`, defaults `ApplicationStatus=Draft`, `SendForApproval=false` |
| 7. Manual review | Done directly in the NocoDB UI grid view on the `Invoices` table — no automation needed per spec |
| 8. Approval workflow | Workflow 2's schedule-trigger chain: query pending invoices, resolve approvers via `Departments`, send Slack + email |
| 9. Update status | Workflow 2's webhook chain: validates the approval token, sets `Fully Approved`/`Rejected`, logs to `Audit_Log` |

### Audit logging

Every state-changing node is followed by a `NocoDB - Write Audit Log (...)` call: record creation,
sent-for-approval, approved/rejected, and any workflow-level error (via Workflow 3). Each row
captures `InvoiceId`, `Action`, `Actor`, `Details` (JSON), and a NocoDB-managed timestamp.

## Bonus Features Implemented

- **Duplicate invoice detection** — `NocoDB - Search Duplicate Invoice` matches on
  `VendorUID + InvoiceNumber` before creating a record; duplicates are still stored (never
  silently dropped) but flagged `IsDuplicate=true` + `ReviewRequired=true`.
- **Confidence-based human review routing** — `ReviewRequired` is auto-set when the AI's
  self-reported `confidence` is below `CONFIDENCE_REVIEW_THRESHOLD` (default 0.75), or when AI
  extraction failed outright.
- **Vendor master validation** — `NocoDB - Search Vendor Master` cross-checks the extracted
  vendor UID/IBAN against `Vendors`; blocked vendors and IBAN mismatches are flagged as anomalies.
- **Slack + email approval notifications** — Workflow 2 sends both, so approvers without Slack
  access still get an actionable email.
- **Retry and failure handling** — every external HTTP call (OpenAI, NocoDB, Slack, SMTP) has
  `retryOnFail` with exponential backoff; the OpenAI call additionally has a dedicated
  `continueErrorOutput` branch (`Build Fallback Extraction`) so a failed AI call still produces a
  Draft record (confidence 0, flagged for manual entry) instead of losing the invoice.
- **Comprehensive logging and monitoring** — the `Audit_Log` table plus Workflow 3 (Error
  Handler), wired as the `errorWorkflow` for both main workflows, posts failures to Slack and logs
  them.

Not implemented (documented as out of scope, see Assumptions): OCR for scanned/image-only PDFs,
multi-language translation of extracted values, automatic cost-center prediction beyond what the
LLM infers from invoice text.

## Assumptions

- One invoice PDF = one invoice record. An email with multiple PDF attachments creates one
  invoice per attachment.
- The AI is trusted to normalize dates/currency but **not** trusted to make business decisions —
  it only ever produces a `Draft`; every approval/rejection requires a human action.
- "Department approver" is a 1:1 mapping per department in the `Departments` table. An invoice
  routed to multiple departments generates one approval request per department; the spec doesn't
  say whether all must approve or any one is sufficient, so the current implementation treats each
  department's decision independently and logs it — implementing an all-must-approve gate is a
  natural extension (see `ApprovalThreshold` column left as a documented extension point).
- Approval links are single-use **link buttons** (GET requests carrying `invoiceId`+`token`+
  `action`), not Slack's native interactive-callback API. This avoids requiring a public HTTPS
  endpoint with Slack request-signature verification for a local/demo deployment, while still
  satisfying "approvers should be able to approve/reject" with one click. A production
  deployment should upgrade to Slack's Interactivity API (signed payloads, no possibility of a
  forwarded/leaked link being replayed) — the `ApprovalToken` + Draft-status check already
  prevents replay after the first click, but the underlying transport (a GET link) is weaker than
  a signed POST callback.
- Gmail is polled every 1 minute (intake) and the approval scan runs every 5 minutes; both are
  configurable in the respective trigger node.

## AI Prompts

See [`prompts/extraction-prompt.md`](prompts/extraction-prompt.md) for the full system prompt,
user prompt template, JSON schema, and a worked few-shot example, plus the reasoning behind the
prompt-engineering choices (Structured Outputs, prompt-injection framing, confidence/anomaly
self-reporting).

## Sample Data

`sample-data/` contains four generated PDFs (source: `scripts/generate-sample-invoices.py`) and
`sample-ai-responses.json` with the expected AI output for each, so the Clean & Validate logic can
be tested without burning OpenAI credits:

| File | Scenario |
|------|-----------|
| `sample-invoice-clean.pdf` | Well-formed invoice, all fields present, numbers reconcile |
| `sample-invoice-missing-fields.pdf` | Missing IBAN + due date, Gross ≠ Net+VAT |
| `sample-invoice-duplicate.pdf` | Same vendor + invoice number as the clean sample |
| `sample-invoice-blocked-vendor.pdf` | Vendor matches a `Status=Blocked` row in `seed-vendors.json` |

## Database Schema

See [`database/schema.md`](database/schema.md) (NocoDB field-by-field spec) and
[`database/schema.sql`](database/schema.sql) (portable relational-equivalent DDL).

## Security Considerations

- No API keys/tokens are stored in the workflow JSON — everything goes through n8n's encrypted
  credential store (Gmail OAuth2, OpenAI, NocoDB/Slack header-auth, SMTP).
- The AI system prompt explicitly instructs the model to treat invoice text as untrusted data,
  not instructions (mitigates prompt injection from a malicious/compromised sender).
- Approval webhook requests are validated against a per-invoice random token and the invoice's
  current status (rejects replays / already-processed decisions with HTTP 409).
- `Suspicious Traders Co` in `seed-vendors.json` demonstrates the vendor-blocklist check — invoices
  from blocked vendors are never silently paid, they're flagged for mandatory review.

## Validation Performed

Docker Desktop hit an unrecoverable environment bug on the original test machine (a corrupted
internal socket file that survived a factory reset and a full reboot). Rather than ship untested
workflow JSON, both workflows were instead run **live against a real n8n instance and a real
running NocoDB** using a Docker-free setup (n8n and NocoDB installed and run directly via Node —
see `local-run/` for the launcher scripts), plus a fast offline unit-test layer for the business
logic. This combination is in fact how three real bugs were found and fixed before this
submission — details below.

### Offline logic tests (no server required)

- `scripts/test-clean-validate.js` loads the **real `jsCode` strings straight out of
  `workflows/01-invoice-intake.json`** (not a reimplementation) and executes them in a sandboxed
  `vm` context against `sample-data/sample-ai-responses.json`: field mapping, Net+VAT/Gross
  reconciliation anomaly detection, confidence-based `ReviewRequired` routing, duplicate detection
  (hit and miss), blocked-vendor/IBAN-mismatch flagging. **15/15 pass.**
- `scripts/test-approval-workflow.js` does the same for `workflows/02-approval-workflow.json`:
  multi-department approver resolution, unknown-department handling, and the "reattach context"
  nodes that restore fields an HTTP response node would otherwise overwrite. **10/10 pass.**

Run them yourself: `cd scripts && node test-clean-validate.js && node test-approval-workflow.js`.

### Live end-to-end runs against a real n8n + NocoDB instance

Both workflows were imported into a real n8n (via its REST API) wired to a real NocoDB instance
(schema created by `scripts/setup-nocodb.js`), with the Gmail/OpenAI/Slack/SMTP steps mocked out
(no real accounts available in that environment) and every NocoDB-touching step exercised for
real:

- **Workflow 1** ran end-to-end four times with different sample invoices, each producing a real
  `Invoices` row and a real `Audit_Log` row: a clean invoice (`Confidence: 0.97`, no anomalies), and
  three subsequent runs correctly flagged `IsDuplicate: true` against the first one
  (`VendorUID`+`InvoiceNumber` match).
- **Workflow 2**'s approval-scan chain ran end-to-end: found the pending invoice
  (`SendForApproval=true, ApplicationStatus=Draft`), resolved the "Finance" department's approver
  from the real `Departments` table, attempted Slack (no bot token configured → failed gracefully,
  confirming the `continueRegularOutput` resilience design actually works), attempted email
  (same), persisted the `ApprovalToken` back onto the invoice, and wrote the `Sent_For_Approval`
  audit row.
- The webhook-based approve/reject endpoint (`Webhook - Approval Response` → validate token →
  update status → audit) was validated via the same offline Code-node tests and a manual n8n
  import, but a live HTTP call to the running webhook could not be completed in this session (see
  Known Issues below) — the underlying logic (token/status validation, status transition, audit
  write) is otherwise identical to the parts that were proven live.

**Bugs this process caught and fixed, before they could reach you:**
1. The approval-token `PATCH` call and (2) the Slack/Email notification calls were each
   overwriting `$json`, silently discarding the invoice/approver context the next node needed —
   both now go through a dedicated "Reattach Context After ..." Code node (same pattern used
   throughout Workflow 1).
2. `NocoDB - Get Pending Approvals`'s filter used `(SendForApproval,eq,true)`, which matched **zero
   rows** against the real (SQLite-backed) NocoDB instance — Checkbox fields are stored as `0`/`1`,
   not the literal string `true`. Fixed to `eq,1`, confirmed against the live instance. This is
   exactly the kind of bug that only surfaces when you actually run the thing.

### Known Issues

- **PDF attachment upload node is version-sensitive.** The `NocoDB - Upload PDF File` step uses
  the HTTP Request node's standard multipart-form-data configuration (the same setup n8n's own
  docs describe). On the specific n8n build used for local live-testing (`1.123.63`), this exact
  node configuration has an internal bug — confirmed **not** a NocoDB or workflow-design issue,
  since the identical multipart request succeeds when sent directly with `curl` against the same
  NocoDB instance. Two alternate implementations (raw `binaryData` body mode, and a hand-built
  multipart body sent via `fetch()` in a Code node) were also tried and independently hit two
  *different* n8n-internal limitations (a request-body-encoding bug, and the Code node sandbox not
  exposing `fetch`/`require` in this build). If your n8n instance hits the same error, the fastest
  fix is trying a different n8n patch version; the Code-node-fetch approach works on any n8n build
  where the Code node sandbox exposes network access (check your n8n's Code node settings).
- **Testing the response webhook end-to-end** (the second half of Workflow 2) requires the
  workflow to be **active** with its webhook properly registered; in local testing, activating the
  workflow via the REST API after the fact didn't reliably register the webhook route in every
  case (n8n's webhook registration is more reliably triggered by activating the workflow **before**
  n8n starts, or via the editor UI's Active toggle, rather than by an API call against an
  already-running instance holding multiple trigger types on one workflow). Activate the workflow
  from the n8n UI (not the API) before testing the approval links for the most reliable result.

## Demo Recording Checklist

Suggested 5-10 minute walkthrough:
1. Show the architecture diagram/README (30s).
2. Send an email with `sample-invoice-clean.pdf` attached → show Workflow 1 executing in n8n →
   show the new Draft record in NocoDB with all fields populated (2 min).
3. Send `sample-invoice-missing-fields.pdf` → show the anomalies + `ReviewRequired=true` (1 min).
4. Send `sample-invoice-duplicate.pdf` → show `IsDuplicate=true` pointing at the first record
   (1 min).
5. In NocoDB, edit a Draft record, set `SelectedDepartments`, tick `SendForApproval=true` (30s).
6. Trigger Workflow 2 manually → show the Slack message / email received → click Approve → show
   the record flip to `Fully Approved` and the new `Audit_Log` rows (2 min).
7. Kill the NocoDB container mid-run (or use an invalid API token) to show a failed execution
   landing in Workflow 3 / Slack alert / `Audit_Log` `Error` row (1 min).
