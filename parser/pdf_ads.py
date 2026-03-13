"""
PDF ADS (Amazon Advertising) invoice parser.

Expected structure:
- "GLOBAL BILLING STATEMENT" document
- Period: e.g. "01-Jan-2026 - 31-Jan-2026"
- Currency: USD with EUR equivalent
- Key field: "Total Amount Due" in EUR
- Invoice IDs, country breakdowns
"""

import re
import io
from typing import Optional, List
from dataclasses import dataclass, field


@dataclass
class AdsBillingEntry:
    country: str = ""
    amount_usd: Optional[float] = None
    amount_eur: Optional[float] = None
    invoice_id: str = ""


@dataclass
class PdfAdsData:
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    total_usd: Optional[float] = None
    total_eur: Optional[float] = None
    invoice_ids: List[str] = field(default_factory=list)
    entries: List[AdsBillingEntry] = field(default_factory=list)
    raw_text: str = ""
    parse_errors: list = field(default_factory=list)


def _parse_number(text: str) -> Optional[float]:
    """Parse a number that may have commas as thousands separators."""
    if not text:
        return None
    text = text.strip().replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def parse_pdf_ads(file_content: bytes, filename: str) -> PdfAdsData:
    """
    Parse an Amazon Advertising monthly billing statement PDF.
    Returns extracted ADS billing data.
    """
    result = PdfAdsData()

    try:
        import pdfplumber
    except ImportError:
        result.parse_errors.append("pdfplumber not installed")
        return result

    try:
        with pdfplumber.open(io.BytesIO(file_content)) as pdf:
            full_text = ""
            for page in pdf.pages:
                page_text = page.extract_text() or ""
                full_text += page_text + "\n"

        result.raw_text = full_text

        # Extract period
        period_match = re.search(
            r'(\d{2}-[A-Za-z]{3}-\d{4})\s*[-–]\s*(\d{2}-[A-Za-z]{3}-\d{4})',
            full_text
        )
        if period_match:
            result.period_start = period_match.group(1)
            result.period_end = period_match.group(2)

        # Extract invoice IDs (pattern like 117466MTPA26)
        invoice_ids = re.findall(r'\b([A-Z0-9]{6,20}MTPA\d{2,4})\b', full_text)
        result.invoice_ids = list(dict.fromkeys(invoice_ids))  # deduplicate, preserve order

        # Extract Total Amount Due
        # Look for USD amount and EUR equivalent
        total_due_match = re.search(
            r'Total\s+Amount\s+Due[^\n]*?([\d,]+\.?\d*)\s*USD',
            full_text, re.IGNORECASE
        )
        if total_due_match:
            result.total_usd = _parse_number(total_due_match.group(1))

        # EUR equivalent near Total Amount Due
        eur_near_total = re.search(
            r'Total\s+Amount\s+Due[^\n]*?(?:[\d,]+\.?\d*\s*USD)[^\n]*?([\d,]+\.?\d*)\s*EUR',
            full_text, re.IGNORECASE
        )
        if eur_near_total:
            result.total_eur = _parse_number(eur_near_total.group(1))

        # If not found inline, look for EUR amount on nearby lines
        if result.total_eur is None and result.total_usd is not None:
            lines = full_text.splitlines()
            for i, line in enumerate(lines):
                if re.search(r'Total\s+Amount\s+Due', line, re.IGNORECASE):
                    # Check this line and next 3 lines for EUR
                    search_block = "\n".join(lines[i:i+4])
                    eur_match = re.search(r'([\d,]+\.?\d*)\s*EUR', search_block)
                    if eur_match:
                        result.total_eur = _parse_number(eur_match.group(1))
                        break

        # Extract Italy subtotal in EUR (for reconciliation)
        italy_eur = _extract_country_eur(full_text, "Italy")
        if italy_eur is not None:
            italy_entry = AdsBillingEntry(country="Italy", amount_eur=italy_eur)
            result.entries.append(italy_entry)

        # Extract other country subtotals if present
        for country in ["Spain", "Germany", "France", "United Kingdom"]:
            country_eur = _extract_country_eur(full_text, country)
            if country_eur is not None:
                result.entries.append(AdsBillingEntry(country=country, amount_eur=country_eur))

        # If no EUR total found, try fallback: sum of country EUR entries
        if result.total_eur is None and result.entries:
            total = sum(e.amount_eur for e in result.entries if e.amount_eur is not None)
            if total > 0:
                result.total_eur = total

        # Final fallback: search for any EUR amount near "total" keyword
        if result.total_eur is None:
            fallback = re.findall(r'(?:total|totale)[^\n]*([\d,]+\.?\d*)\s*EUR', full_text, re.IGNORECASE)
            if fallback:
                result.total_eur = _parse_number(fallback[-1])

        if result.total_eur is None and result.total_usd is None:
            result.parse_errors.append(
                f"Impossibile estrarre importo totale dal PDF ADS '{filename}'"
            )

    except Exception as e:
        result.parse_errors.append(f"Errore parsing PDF ADS '{filename}': {str(e)}")

    return result


def _extract_country_eur(text: str, country: str) -> Optional[float]:
    """Extract EUR subtotal for a specific country from the billing statement."""
    # Pattern: "Italy  123.45 USD  100.20 EUR" or similar
    pattern = rf'{re.escape(country)}[^\n]*([\d,]+\.?\d*)\s*EUR'
    match = re.search(pattern, text, re.IGNORECASE)
    if match:
        return _parse_number(match.group(1))
    return None
