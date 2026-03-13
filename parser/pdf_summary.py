"""
PDF Summary parser for Amazon Seller Central monthly payment summary PDFs.

Actual PDF structure (from real Amazon IT export):
  Sintesi section with 4 rows:
    Ricavi          Vendite, accrediti e rimborsi          1.548,61
    Spese           Costi inclusivi di commissioni...     -1.381,55
    Imposte         Imposte nette riscosse...               377,91
    Trasferimenti   Versamenti e prelievi                  -177,87

Italian number format: 1.548,61 (dot=thousands, comma=decimal)
"""

import re
import io
from typing import Optional
from dataclasses import dataclass, field


@dataclass
class PdfSummaryData:
    ricavi: Optional[float] = None
    spese: Optional[float] = None
    imposte: Optional[float] = None
    trasferimenti: Optional[float] = None
    raw_text: str = ""
    parse_errors: list = field(default_factory=list)

    @property
    def balance_check(self) -> Optional[float]:
        vals = [self.ricavi, self.spese, self.imposte, self.trasferimenti]
        if any(v is None for v in vals):
            return None
        return round(sum(vals), 2)


def _parse_italian_number(text: str) -> Optional[float]:
    """Parse Italian-formatted number like '1.548,61' or '-177,87'."""
    if not text:
        return None
    text = text.strip()
    sign = 1
    if text.startswith("+"):
        text = text[1:]
    elif text.startswith("-"):
        sign = -1
        text = text[1:]
    text = re.sub(r'[€EUR\s]+', '', text)
    # Italian: 1.548,61 → remove thousands dot, swap decimal comma
    text = text.replace(".", "").replace(",", ".")
    try:
        return sign * float(text)
    except ValueError:
        return None


def parse_pdf_summary(file_content: bytes, filename: str) -> PdfSummaryData:
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
        result = _parse_sintesi_section(full_text, result)

        if result.ricavi is None and result.spese is None:
            result.parse_errors.append(
                "Impossibile estrarre dati dalla sezione Sintesi del PDF Summary"
            )

    except Exception as e:
        result.parse_errors.append(f"Errore parsing PDF Summary '{filename}': {str(e)}")

    return result


# Italian number pattern: optional sign, digits with optional dot-thousands, comma decimal
_NUM = r'(-?[\d]{1,3}(?:\.[\d]{3})*,\d{2})'


def _parse_sintesi_section(text: str, result: PdfSummaryData) -> PdfSummaryData:
    """
    Extract values from the Sintesi section.

    Strategy:
    1. Isolate text around the 'Sintesi' keyword (first ~600 chars after it)
    2. In that window, find each of the 4 labels and capture the last number on
       the same line (which is the 'Totale' column value in the PDF table).
    3. Fallback: scan full text with broader patterns.
    """
    # ── Step 1: isolate Sintesi window ────────────────────────────────────────
    sintesi_match = re.search(r'Sintesi', text, re.IGNORECASE)
    window = text[sintesi_match.start():sintesi_match.start() + 800] if sintesi_match else text

    # ── Step 2: label → target field mapping (order matters — most specific first)
    # Each entry: (field_name, regex_for_label)
    label_map = [
        ("ricavi",        r'Ricavi(?!\s+articoli|\s+per|\s+della|\s+dai|\s+parziale)'),
        ("spese",         r'Spese(?!\s+totali\s+parziale|\s+parziale)'),
        ("imposte",       r'Imposte(?!\s+relative|\s+parziale)'),
        ("trasferimenti", r'Trasferimenti(?!\s+sul|\s+non|\s+parziale)'),
    ]

    amount_re = re.compile(_NUM)
    lines = window.splitlines()

    for field_name, label_pat in label_map:
        if getattr(result, field_name) is not None:
            continue
        label_re = re.compile(label_pat, re.IGNORECASE)
        for line in lines:
            if label_re.search(line):
                amounts = amount_re.findall(line)
                if amounts:
                    # Take the LAST number on the line = Totale column
                    setattr(result, field_name, _parse_italian_number(amounts[-1]))
                    break

    # ── Step 3: fallback — scan full text if window strategy missed anything ──
    if result.ricavi is None:
        result.ricavi = _first_amount_after(text, r'Ricavi\b', amount_re)
    if result.spese is None:
        result.spese = _first_amount_after(text, r'Spese\b', amount_re)
    if result.imposte is None:
        result.imposte = _first_amount_after(text, r'Imposte\b', amount_re)
    if result.trasferimenti is None:
        result.trasferimenti = _first_amount_after(
            text, r'(?:Trasferimenti\b|Versamenti\s+e\s+prelievi)', amount_re
        )

    return result


def _first_amount_after(text: str, label_pat: str, amount_re: re.Pattern) -> Optional[float]:
    """Find label in text and return the last Italian number on its line."""
    match = re.search(label_pat, text, re.IGNORECASE)
    if not match:
        return None
    # Extract to end of line
    eol = text.find('\n', match.start())
    line = text[match.start(): eol if eol != -1 else match.start() + 200]
    amounts = amount_re.findall(line)
    if amounts:
        return _parse_italian_number(amounts[-1])
    return None
