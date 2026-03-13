"""
PDF Summary parser for Amazon Seller Central monthly payment summary PDFs.

Expected structure:
- Contains a "Sintesi" section with 4 main lines:
  Ricavi totali, Spese totali, Imposte nette, Trasferimenti
- Italian number format with comma decimal separator and dot thousands separator
"""

import re
import io
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class PdfSummaryData:
    ricavi: Optional[float] = None       # Total revenues (positive)
    spese: Optional[float] = None        # Total expenses (negative)
    imposte: Optional[float] = None      # Net taxes
    trasferimenti: Optional[float] = None  # Transfers to bank (negative)
    raw_text: str = ""
    parse_errors: list = field(default_factory=list)

    @property
    def balance_check(self) -> Optional[float]:
        """ricavi + spese + imposte + trasferimenti should equal ~0 (remaining Amazon balance)."""
        vals = [self.ricavi, self.spese, self.imposte, self.trasferimenti]
        if any(v is None for v in vals):
            return None
        return round(sum(vals), 2)


def _parse_italian_number(text: str) -> Optional[float]:
    """Parse Italian-formatted number like '+1.548,61' or '-177,87'."""
    if not text:
        return None
    text = text.strip()
    sign = 1
    if text.startswith("+"):
        text = text[1:]
    elif text.startswith("-"):
        sign = -1
        text = text[1:]
    # Remove currency suffix and whitespace
    text = re.sub(r'[€EUR\s]+', '', text)
    # Remove thousands dots, replace decimal comma
    text = text.replace(".", "").replace(",", ".")
    try:
        return sign * float(text)
    except ValueError:
        return None


def _extract_amount_after_label(text: str, label_pattern: str) -> Optional[float]:
    """Find a label and extract the first monetary amount that follows it."""
    # Look for label followed by amount on same or next line
    pattern = label_pattern + r'[^\n]*?([+-]?[\d.,]+\s*EUR)'
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if match:
        return _parse_italian_number(match.group(1).replace("EUR", "").strip())
    # Fallback: label then amount on next line
    pattern2 = label_pattern + r'\s*\n\s*([+-]?[\d.,]+)'
    match2 = re.search(pattern2, text, re.IGNORECASE)
    if match2:
        return _parse_italian_number(match2.group(1))
    return None


def parse_pdf_summary(file_content: bytes, filename: str) -> PdfSummaryData:
    """
    Parse an Amazon Seller Central monthly summary PDF.
    Returns extracted financial summary data.
    """
    result = PdfSummaryData()

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

        # Try to find structured table data first
        result = _parse_sintesi_section(full_text, result)

        # Fallback: scan for labeled amounts anywhere in text
        if result.ricavi is None:
            result.ricavi = _extract_amount_after_label(full_text, r'Ricavi\s+totali')
        if result.spese is None:
            result.spese = _extract_amount_after_label(full_text, r'Spese\s+totali')
        if result.imposte is None:
            result.imposte = _extract_amount_after_label(full_text, r'Imposte\s+nette')
        if result.trasferimenti is None:
            result.trasferimenti = _extract_amount_after_label(
                full_text, r'(?:Versamenti\s+e\s+prelievi|Trasferimenti)'
            )

        if result.ricavi is None and result.spese is None:
            result.parse_errors.append(
                "Impossibile estrarre dati dalla sezione Sintesi del PDF Summary"
            )

    except Exception as e:
        result.parse_errors.append(f"Errore parsing PDF Summary '{filename}': {str(e)}")

    return result


def _parse_sintesi_section(text: str, result: PdfSummaryData) -> PdfSummaryData:
    """
    Extract the Sintesi section values.
    The section typically looks like:
        Ricavi totali  +1.548,61 EUR
        Spese totali   -1.381,55 EUR
        Imposte nette  +377,91 EUR
        Versamenti e prelievi  -177,87 EUR
    """
    lines = text.splitlines()

    label_patterns = {
        "ricavi": re.compile(r'Ricavi\s+totali', re.IGNORECASE),
        "spese": re.compile(r'Spese\s+totali', re.IGNORECASE),
        "imposte": re.compile(r'Imposte\s+nette', re.IGNORECASE),
        "trasferimenti": re.compile(
            r'(?:Versamenti\s+e\s+prelievi|Trasferimenti\s+totali|Trasferimenti)',
            re.IGNORECASE
        ),
    }

    amount_pattern = re.compile(r'([+-]?[\d.]+,\d{2})\s*(?:EUR)?')

    for i, line in enumerate(lines):
        for key, pattern in label_patterns.items():
            if pattern.search(line) and getattr(result, key) is None:
                # Search for amount on the same line first
                amounts = amount_pattern.findall(line)
                if amounts:
                    setattr(result, key, _parse_italian_number(amounts[-1]))
                else:
                    # Check the next 1-2 lines
                    for j in range(1, 3):
                        if i + j < len(lines):
                            next_amounts = amount_pattern.findall(lines[i + j])
                            if next_amounts:
                                setattr(result, key, _parse_italian_number(next_amounts[0]))
                                break

    return result
