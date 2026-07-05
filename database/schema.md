# Database Schema — NocoDB

Platform: **NocoDB** (free, self-hosted via Docker, REST API compatible with n8n's native NocoDB node).
Base name used in the workflows: `InvoiceAutomation`.

See [`schema.sql`](schema.sql) for the relational-equivalent DDL (useful if you'd rather run this on
Postgres/MySQL directly instead of NocoDB — NocoDB itself does not require you to write SQL, tables
are created below via UI/API).

## Table 1 — `Invoices` (core table)

| Field                | NocoDB Type            | Notes |
|----------------------|-------------------------|-------|
| Id                    | Auto Number (PK)        | created automatically |
| Vendor                | Single Line Text        | required |
| VendorUID             | Single Line Text        | |
| VendorIBAN            | Single Line Text        | |
| InvoiceNumber         | Single Line Text        | used with VendorUID for duplicate detection |
| InvoiceDate           | Date                     | |
| DueDate               | Date                     | |
| NetAmount             | Decimal                 | |
| VATAmount             | Decimal                 | |
| VATPercent            | Percent                 | |
| GrossAmount           | Decimal                 | |
| Currency              | Single Select           | USD, EUR, GBP, INR, AED, ... |
| CostCenter            | Single Line Text        | AI-suggested, editable by reviewer |
| LineItems             | JSON (Long Text)        | array of `{description, quantity, unit_price, amount}` |
| Confidence            | Decimal (0–1)           | AI self-reported extraction confidence |
| Anomalies             | JSON (Long Text)        | array of anomaly strings from the AI, e.g. `"Gross ≠ Net + VAT"` |
| ApplicationStatus     | Single Select           | `Draft` \| `Fully Approved` \| `Rejected` — default `Draft` |
| SelectedDepartments   | Multi Select            | Finance, IT, Operations, Marketing, HR, Procurement |
| SendForApproval       | Checkbox                | default `false` |
| ReviewRequired        | Checkbox                | **bonus**: auto-set `true` when Confidence < 0.75 |
| IsDuplicate           | Checkbox                | **bonus**: set by duplicate-detection step |
| DuplicateOfId         | Linked Record → Invoices| **bonus**: points at the original invoice |
| ApprovalToken         | Single Line Text        | random token embedded in email approve/reject links |
| Source                | Single Line Text        | default `Email` |
| Sender                | Single Line Text        | raw `From` header |
| SenderEmail           | Email                    | |
| SenderName            | Single Line Text        | display name parsed from `From` header |
| EmailSubject          | Single Line Text        | |
| EmailReceived         | Checkbox                | default `true` |
| ReceivedAt            | Date & Time              | |
| PDFAttachment         | Attachment               | original invoice PDF |
| CreatedAt / UpdatedAt | Created/Last Modified Time (system) | auto-managed by NocoDB |

## Table 2 — `Departments` (approver routing)

| Field              | NocoDB Type       | Notes |
|--------------------|--------------------|-------|
| DepartmentName      | Single Line Text (PK) | Finance, IT, Operations, Marketing, HR, Procurement |
| ApproverName        | Single Line Text  | |
| ApproverEmail       | Email              | used for the email-approval fallback |
| ApproverSlackId     | Single Line Text  | Slack member ID, used to DM the interactive approval card |
| ApprovalThreshold   | Decimal            | optional; amounts above this could require a second approver (not wired up by default — documented as an extension point) |

## Table 3 — `Vendors` (vendor master — bonus: vendor master validation)

| Field       | NocoDB Type    | Notes |
|-------------|----------------|-------|
| VendorName  | Single Line Text (PK) | |
| VendorUID   | Single Line Text | matched against AI-extracted `Vendor UID` |
| VendorIBAN  | Single Line Text | matched against AI-extracted `Vendor IBAN` — mismatch is flagged as an anomaly |
| Status      | Single Select   | `Active` \| `Blocked` \| `Unverified` |
| Notes       | Long Text       | |

## Table 4 — `Audit_Log` (append-only audit trail)

| Field       | NocoDB Type          | Notes |
|-------------|----------------------|-------|
| InvoiceId   | Linked Record → Invoices | |
| Action      | Single Select        | `Email_Received`, `PDF_Extracted`, `AI_Extraction_Success`, `AI_Extraction_Failed`, `Duplicate_Flagged`, `Record_Created`, `Reviewed`, `Sent_For_Approval`, `Approved`, `Rejected`, `Error`, `Retry` |
| Actor       | Single Line Text     | `system:openai-extraction`, `user:reviewer@company.com`, `approver:finance-head@company.com` |
| Details     | Long Text (JSON)     | before/after values, error messages, model name/version used |
| CreatedAt   | Created Time (system)| auto-managed |

Every workflow node that mutates an `Invoices` record writes a matching row to `Audit_Log` in the
same execution — see `workflows/README` section "Audit logging" for the exact node wiring.

## How the tables were created

`scripts/setup-nocodb.js` calls the NocoDB REST API to create the base and all four tables/fields
in one shot (idempotent — safe to re-run). See the main [README](../README.md#database-setup) for
the exact command. If you'd rather click through the UI, the field list above is exactly what to
enter, in order.

## Seed data

`database/seed-departments.json` and `database/seed-vendors.json` contain the sample rows loaded by
`scripts/setup-nocodb.js` so the approval-routing and vendor-validation steps have something to
match against out of the box.
