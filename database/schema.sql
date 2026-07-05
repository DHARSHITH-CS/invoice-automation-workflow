-- ============================================================================
-- Invoice Automation Workflow - Database Schema
-- ============================================================================
-- Target platform: NocoDB (SQLite/Postgres backend). This DDL is the
-- relational equivalent of the NocoDB base described in schema.md, provided
-- for portability / documentation purposes and for anyone who wants to run
-- the same schema on a plain Postgres/MySQL instance instead of NocoDB.
--
-- Table creation order matters because of foreign keys.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Vendors: master list used for vendor validation (bonus feature)
-- ----------------------------------------------------------------------------
CREATE TABLE vendors (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,   -- SERIAL on Postgres
    vendor_name         TEXT NOT NULL,
    vendor_uid          TEXT,
    vendor_iban         TEXT,
    status              TEXT NOT NULL DEFAULT 'Unverified'   -- Active | Blocked | Unverified
        CHECK (status IN ('Active', 'Blocked', 'Unverified')),
    notes               TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_vendors_uid ON vendors (vendor_uid);

-- ----------------------------------------------------------------------------
-- Departments: approver routing table
-- ----------------------------------------------------------------------------
CREATE TABLE departments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    department_name     TEXT NOT NULL UNIQUE,   -- Finance, IT, Operations, Marketing, HR, Procurement
    approver_name        TEXT NOT NULL,
    approver_email        TEXT NOT NULL,
    approver_slack_id     TEXT,                    -- Slack member ID, used for DM approval buttons
    approval_threshold   DECIMAL(14,2),           -- optional: amounts above this need a second approver
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- Invoices: core table populated by Workflow 1 (Intake) and updated by
-- Workflow 2 (Approval)
-- ----------------------------------------------------------------------------
CREATE TABLE invoices (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,

    -- AI-extracted invoice fields
    vendor                TEXT,
    vendor_uid            TEXT,
    vendor_iban           TEXT,
    invoice_number        TEXT,
    invoice_date          DATE,
    due_date              DATE,
    net_amount            DECIMAL(14,2),
    vat_amount            DECIMAL(14,2),
    vat_percent           DECIMAL(5,2),
    gross_amount          DECIMAL(14,2),
    currency              TEXT,
    cost_center           TEXT,
    line_items            TEXT,        -- JSON array: [{description, quantity, unit_price, amount}, ...]
    confidence            DECIMAL(4,3),  -- 0.000 - 1.000, AI self-reported confidence
    anomalies             TEXT,        -- JSON array of strings, e.g. ["Gross != Net+VAT", "Due date before invoice date"]

    -- workflow / review state
    application_status    TEXT NOT NULL DEFAULT 'Draft'
        CHECK (application_status IN ('Draft', 'Fully Approved', 'Rejected')),
    selected_departments  TEXT,        -- comma-separated or JSON array of department_name values
    send_for_approval     BOOLEAN NOT NULL DEFAULT 0,
    review_required       BOOLEAN NOT NULL DEFAULT 0,   -- true when confidence < threshold (bonus: confidence-based routing)
    is_duplicate          BOOLEAN NOT NULL DEFAULT 0,   -- bonus: duplicate invoice detection
    duplicate_of_id       INTEGER REFERENCES invoices(id),
    approval_token        TEXT,        -- signed token embedded in email approve/reject links

    -- source email metadata
    source                TEXT NOT NULL DEFAULT 'Email',
    sender                TEXT,
    sender_email          TEXT,
    sender_name           TEXT,
    email_subject         TEXT,
    email_received        BOOLEAN NOT NULL DEFAULT 1,
    received_at           DATETIME,

    -- original document
    pdf_attachment_url    TEXT,        -- NocoDB attachment field stores file + returns a URL/path

    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invoices_status ON invoices (application_status, send_for_approval);
CREATE INDEX idx_invoices_vendor_number ON invoices (vendor_uid, invoice_number); -- duplicate detection lookup

-- ----------------------------------------------------------------------------
-- Audit_Log: append-only trail of every action taken on an invoice
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id          INTEGER NOT NULL REFERENCES invoices(id),
    action              TEXT NOT NULL
        CHECK (action IN (
            'Email_Received', 'PDF_Extracted', 'AI_Extraction_Success', 'AI_Extraction_Failed',
            'Duplicate_Flagged', 'Record_Created', 'Reviewed', 'Sent_For_Approval',
            'Approved', 'Rejected', 'Error', 'Retry'
        )),
    actor               TEXT NOT NULL,   -- e.g. 'system:openai-extraction', 'user:reviewer@company.com', 'approver:finance-head@company.com'
    details             TEXT,            -- JSON blob: before/after values, error message, model used, etc.
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_invoice ON audit_log (invoice_id, created_at);
