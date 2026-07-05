"""
Generates sample supplier invoice PDFs used to test the intake workflow.

Scenarios:
  1. sample-invoice-clean.pdf        - well-formed invoice, should extract with high confidence
  2. sample-invoice-missing-fields.pdf - missing IBAN + due date, inconsistent gross amount
  3. sample-invoice-duplicate.pdf    - same vendor+invoice number as (1), to exercise duplicate detection
  4. sample-invoice-blocked-vendor.pdf - vendor that matches the "Blocked" row in seed-vendors.json

Run: python generate-sample-invoices.py
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "sample-data")
os.makedirs(OUT_DIR, exist_ok=True)


def draw_invoice(path, vendor, vendor_uid, vendor_iban, invoice_number, invoice_date, due_date,
                  line_items, vat_percent, currency, cost_center, gross_override=None, omit_iban=False,
                  omit_due_date=False):
    c = canvas.Canvas(path, pagesize=A4)
    width, height = A4
    y = height - 30 * mm

    c.setFont("Helvetica-Bold", 16)
    c.drawString(20 * mm, y, vendor)
    y -= 8 * mm

    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, y, f"Vendor UID: {vendor_uid}")
    y -= 5 * mm
    if not omit_iban:
        c.drawString(20 * mm, y, f"IBAN: {vendor_iban}")
        y -= 5 * mm
    y -= 5 * mm

    c.setFont("Helvetica-Bold", 12)
    c.drawString(20 * mm, y, f"Invoice No: {invoice_number}")
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, y, f"Invoice Date: {invoice_date}")
    if not omit_due_date:
        c.drawString(90 * mm, y, f"Due Date: {due_date}")
    y -= 10 * mm

    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Description")
    c.drawString(110 * mm, y, "Qty")
    c.drawString(130 * mm, y, "Unit Price")
    c.drawString(160 * mm, y, "Amount")
    y -= 5 * mm
    c.line(20 * mm, y, 190 * mm, y)
    y -= 6 * mm

    c.setFont("Helvetica", 10)
    net_total = 0.0
    for desc, qty, unit_price in line_items:
        amount = round(qty * unit_price, 2)
        net_total += amount
        c.drawString(20 * mm, y, desc)
        c.drawString(110 * mm, y, str(qty))
        c.drawString(130 * mm, y, f"{unit_price:.2f}")
        c.drawString(160 * mm, y, f"{amount:.2f}")
        y -= 6 * mm

    y -= 6 * mm
    vat_amount = round(net_total * vat_percent / 100.0, 2)
    gross_amount = gross_override if gross_override is not None else round(net_total + vat_amount, 2)

    c.setFont("Helvetica", 10)
    c.drawString(120 * mm, y, f"Net Amount:")
    c.drawString(160 * mm, y, f"{net_total:.2f} {currency}")
    y -= 6 * mm
    c.drawString(120 * mm, y, f"VAT ({vat_percent}%):")
    c.drawString(160 * mm, y, f"{vat_amount:.2f} {currency}")
    y -= 6 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(120 * mm, y, f"Gross Amount:")
    c.drawString(160 * mm, y, f"{gross_amount:.2f} {currency}")
    y -= 10 * mm

    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, y, f"Cost Center: {cost_center}")

    c.showPage()
    c.save()
    print("wrote", path)


# 1. Clean invoice - should extract cleanly, high confidence
draw_invoice(
    os.path.join(OUT_DIR, "sample-invoice-clean.pdf"),
    vendor="Northwind Office Supplies Pvt Ltd",
    vendor_uid="VEN-1001",
    vendor_iban="DE89370400440532013000",
    invoice_number="INV-2026-0143",
    invoice_date="12/06/2026",
    due_date="12/07/2026",
    line_items=[
        ("A4 Paper Ream (500 sheets)", 50, 4.50),
        ("Ergonomic Office Chair", 3, 120.00),
    ],
    vat_percent=19,
    currency="EUR",
    cost_center="FAC-OPS-04",
)

# 2. Missing fields - no IBAN, no due date, gross deliberately wrong -> anomaly + low-ish confidence
draw_invoice(
    os.path.join(OUT_DIR, "sample-invoice-missing-fields.pdf"),
    vendor="Bluewave IT Services LLC",
    vendor_uid="VEN-1002",
    vendor_iban="GB29NWBK60161331926819",
    invoice_number="BW-77821",
    invoice_date="01/06/2026",
    due_date="",
    line_items=[
        ("Monthly Cloud Hosting - June 2026", 1, 850.00),
        ("Support Retainer", 1, 200.00),
    ],
    vat_percent=20,
    currency="GBP",
    cost_center="IT-CLOUD-01",
    gross_override=1000.00,  # net=1050, vat=210 -> expected gross 1260, but stated 1000 => anomaly
    omit_iban=True,
    omit_due_date=True,
)

# 3. Duplicate of invoice #1 (same vendor UID + invoice number) - exercises duplicate detection
draw_invoice(
    os.path.join(OUT_DIR, "sample-invoice-duplicate.pdf"),
    vendor="Northwind Office Supplies Pvt Ltd",
    vendor_uid="VEN-1001",
    vendor_iban="DE89370400440532013000",
    invoice_number="INV-2026-0143",  # same as sample #1 on purpose
    invoice_date="12/06/2026",
    due_date="12/07/2026",
    line_items=[
        ("A4 Paper Ream (500 sheets)", 50, 4.50),
        ("Ergonomic Office Chair", 3, 120.00),
    ],
    vat_percent=19,
    currency="EUR",
    cost_center="FAC-OPS-04",
)

# 4. Blocked vendor (matches seed-vendors.json "Suspicious Traders Co", Status=Blocked)
draw_invoice(
    os.path.join(OUT_DIR, "sample-invoice-blocked-vendor.pdf"),
    vendor="Suspicious Traders Co",
    vendor_uid="VEN-9999",
    vendor_iban="XX00000000000000000000",
    invoice_number="ST-000451",
    invoice_date="20/06/2026",
    due_date="20/07/2026",
    line_items=[
        ("Consulting Services", 10, 500.00),
    ],
    vat_percent=0,
    currency="USD",
    cost_center="OPS-MISC-00",
)

print("Done.")
