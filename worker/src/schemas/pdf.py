"""PDF document metadata extraction schema."""

from pydantic import BaseModel, Field


class Section(BaseModel):
    """A section from a PDF document."""

    title: str
    summary: str


class InvoiceLineItem(BaseModel):
    """A single invoice line item."""

    description: str = ""
    quantity: str = ""
    unit_price: str = ""
    amount: str = ""
    vat_rate: str = ""


class InvoiceMetadata(BaseModel):
    """Structured invoice metadata extracted from PDF documents."""

    is_invoice: bool = False
    sender: str = ""
    receiver: str = ""
    invoice_identifier: str | None = None
    invoice_number: str = ""
    invoice_date: str = ""
    due_date: str = ""
    currency: str = ""
    subtotal: str = ""
    vat_amount: str = ""
    total_amount: str = ""
    line_items: list[InvoiceLineItem] = Field(default_factory=list)


class PDFMetadata(BaseModel):
    """Metadata extracted from PDF documents."""

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    key_entities: list[str] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    invoice: InvoiceMetadata = Field(default_factory=InvoiceMetadata)


# Prompt template for PDF metadata extraction
PROMPT = """Analyze this PDF document and extract metadata.

Provide:
- summary_short: A one-sentence summary of the document
- summary_medium: A 2-3 sentence summary of the document
- summary_long: A detailed paragraph summary of the document
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords for quick scan/search
- key_entities: List of key entities, names, or concepts mentioned
- sections: List of major sections with title and summary
- invoice: Structured invoice details when the document is an invoice/bill/receipt

Invoice-specific requirements:
- If the PDF is an invoice (or bill/receipt), set invoice.is_invoice=true and fill invoice fields when present.
- Extract an invoice identifier into invoice.invoice_identifier when present (for example: invoice number, bill number, reference ID). This field may be null if missing.
- If invoice_number is present in the document, also fill invoice.invoice_number for backward compatibility.
- For invoices, summary_short must include: sender, receiver, invoice identifier (if present), invoice date, total amount (+ currency), VAT/tax amount, and the primary billed item/service.
- For invoices, summary_medium and summary_long should include invoice identifier/invoice number, invoice date, due date, subtotal, VAT/tax, total, and key line items.
- If a field is not found, keep it as an empty string (or empty list for line_items).
- If the PDF is not an invoice, keep invoice.is_invoice=false and leave other invoice fields empty.

PDF content:
{text}

Respond with valid JSON matching this schema: {schema}"""
